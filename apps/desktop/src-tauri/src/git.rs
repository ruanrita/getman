//! Git storage: runs the system `git` and reads/writes `.getman/` files.
//!
//! Only a fixed set of git operations is exposed (no arbitrary arguments), and
//! file writes are confined to `<dir>/.getman/`. Authentication is whatever the
//! user's git already uses (SSH agent, Git Credential Manager); Getman never
//! sees credentials. Prompts that would need a terminal fail instead of hanging.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const GETMAN_DIR: &str = ".getman";
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct GitOutput {
    ok: bool,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    has_getman: bool,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// `git status --porcelain` lines limited to `.getman/`.
    changes: Vec<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Git is not installed or not on PATH. Install it from https://git-scm.com and restart Getman.".to_string()
        } else {
            e.to_string()
        }
    })?;
    let mut output = String::from_utf8_lossy(&out.stdout).to_string();
    output.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(GitOutput { ok: out.status.success(), output: output.trim().to_string() })
}

fn existing_dir(dir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err(format!("Folder not found: {dir}"));
    }
    Ok(path)
}

/// `<dir>/.getman/<rel>`, rejecting absolute paths and `..` so writes cannot escape.
fn getman_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("Invalid file path: {rel}"));
    }
    Ok(dir.join(GETMAN_DIR).join(rel_path))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_version() -> Result<String, String> {
    blocking(|| {
        let out = git(&std::env::temp_dir(), &["--version"])?;
        if out.ok { Ok(out.output) } else { Err(out.output) }
    })
    .await
}

#[tauri::command]
pub async fn git_status(dir: String) -> Result<GitStatus, String> {
    blocking(move || {
        let path = existing_dir(&dir)?;
        let has_getman = path.join(GETMAN_DIR).join("workspace.yaml").is_file();
        let inside = git(&path, &["rev-parse", "--is-inside-work-tree"])?;
        if !inside.ok || inside.output != "true" {
            return Ok(GitStatus { is_repo: false, has_getman, branch: None, upstream: None, ahead: 0, behind: 0, changes: vec![] });
        }
        let status = git(&path, &["status", "--porcelain=v1", "--branch", "--untracked-files=all", "--", GETMAN_DIR])?;
        if !status.ok {
            return Err(status.output);
        }
        let mut st = GitStatus { is_repo: true, has_getman, branch: None, upstream: None, ahead: 0, behind: 0, changes: vec![] };
        for line in status.output.lines() {
            if let Some(head) = line.strip_prefix("## ") {
                // "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
                let (names, counts) = head.split_once(" [").unwrap_or((head, ""));
                let names = names.trim_start_matches("No commits yet on ");
                let (branch, upstream) = names.split_once("...").map(|(b, u)| (b, Some(u))).unwrap_or((names, None));
                st.branch = Some(branch.to_string());
                st.upstream = upstream.map(str::to_string);
                for part in counts.trim_end_matches(']').split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") { st.ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = part.strip_prefix("behind ") { st.behind = n.parse().unwrap_or(0); }
                }
            } else if !line.is_empty() {
                st.changes.push(line.to_string());
            }
        }
        Ok(st)
    })
    .await
}

/// Fetches and fast-forwards only: never creates merge commits behind the user's back.
#[tauri::command]
pub async fn git_pull(dir: String) -> Result<GitOutput, String> {
    blocking(move || git(&existing_dir(&dir)?, &["pull", "--ff-only"])).await
}

/// Commits only `.getman/` (other staged work is left alone), then pushes.
#[tauri::command]
pub async fn git_commit_push(dir: String, message: String) -> Result<GitOutput, String> {
    blocking(move || {
        let path = existing_dir(&dir)?;
        let msg = message.trim();
        if msg.is_empty() {
            return Err("Write a commit message".into());
        }
        let add = git(&path, &["add", "--all", "--", GETMAN_DIR])?;
        if !add.ok {
            return Ok(add);
        }
        let commit = git(&path, &["commit", "-m", msg, "--", GETMAN_DIR])?;
        if !commit.ok && !commit.output.contains("nothing to commit") {
            return Ok(commit);
        }
        let remotes = git(&path, &["remote"])?;
        if remotes.output.is_empty() {
            return Ok(GitOutput {
                ok: true,
                output: format!("{}\nCommitted locally. This repository has no remote yet: add one (e.g. git remote add origin <url>) to push.", commit.output).trim().to_string(),
            });
        }
        let has_upstream = git(&path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.ok;
        let push = if has_upstream { git(&path, &["push"])? } else { git(&path, &["push", "--set-upstream", "origin", "HEAD"])? };
        Ok(GitOutput { ok: push.ok, output: format!("{}\n{}", commit.output, push.output).trim().to_string() })
    })
    .await
}

/// Clones `url` into `parent/<repo name>` and returns that folder.
#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> Result<String, String> {
    blocking(move || {
        let parent_path = existing_dir(&parent)?;
        if url.starts_with('-') {
            return Err("Invalid repository URL".into());
        }
        let name = url.trim_end_matches('/').trim_end_matches(".git").rsplit(['/', ':']).next().unwrap_or("repo").to_string();
        let out = git(&parent_path, &["clone", "--", &url, &name])?;
        if !out.ok {
            return Err(out.output);
        }
        Ok(parent_path.join(name).to_string_lossy().to_string())
    })
    .await
}

/// `git init` in `dir` (branch `main`), optionally adding `remote` as `origin`.
#[tauri::command]
pub async fn git_init(dir: String, remote: Option<String>) -> Result<GitOutput, String> {
    blocking(move || {
        let path = existing_dir(&dir)?;
        let mut log = vec![];
        let init = git(&path, &["init", "--initial-branch=main"])?;
        if !init.ok {
            return Ok(init);
        }
        log.push(init.output);
        if let Some(url) = remote.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
            if url.starts_with('-') {
                return Err("Invalid remote URL".into());
            }
            let add = git(&path, &["remote", "add", "origin", "--", &url])?;
            log.push(if add.ok { format!("Remote origin set to {url}") } else { add.output.clone() });
            if !add.ok {
                return Ok(GitOutput { ok: false, output: log.join("\n") });
            }
        }
        Ok(GitOutput { ok: true, output: log.join("\n") })
    })
    .await
}

/// Every YAML file under `<dir>/.getman/`, keyed by path relative to it (forward slashes).
#[tauri::command]
pub async fn getman_read(dir: String) -> Result<HashMap<String, String>, String> {
    blocking(move || {
        let root = existing_dir(&dir)?.join(GETMAN_DIR);
        let mut files = HashMap::new();
        if !root.is_dir() {
            return Ok(files);
        }
        let mut stack = vec![root.clone()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_dir() {
                    stack.push(path);
                } else if kind.is_file() && path.extension().is_some_and(|e| e == "yaml" || e == "yml") {
                    if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
                        return Err(format!("{} is larger than 5 MB", path.display()));
                    }
                    let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
                    files.insert(rel, fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?);
                }
            }
        }
        Ok(files)
    })
    .await
}

#[derive(serde::Deserialize)]
pub struct FileWrite {
    path: String,
    /// `None` deletes the file.
    content: Option<String>,
}

/// Applies writes/deletes under `.getman/` and removes directories left empty.
#[tauri::command]
pub async fn getman_write(dir: String, writes: Vec<FileWrite>) -> Result<(), String> {
    blocking(move || {
        let base = existing_dir(&dir)?;
        let root = base.join(GETMAN_DIR);
        for w in &writes {
            let path = getman_path(&base, &w.path)?;
            match &w.content {
                Some(content) => {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
                }
                None => {
                    if path.is_file() {
                        fs::remove_file(&path).map_err(|e| e.to_string())?;
                    }
                    let mut parent = path.parent();
                    while let Some(p) = parent {
                        if p == root || fs::remove_dir(p).is_err() {
                            break; // stops at the first non-empty directory
                        }
                        parent = p.parent();
                    }
                }
            }
        }
        Ok(())
    })
    .await
}
