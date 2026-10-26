//! Automatic local backups: files in a folder on this computer
//! (default `Documents/Getman/backups`). Only plain `*.getman.yaml` file names
//! are accepted, so the webview cannot read or write anything else.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
pub struct BackupFile {
    name: String,
    size: u64,
    /// Milliseconds since the Unix epoch.
    modified: u64,
}

fn file_in(dir: &str, name: &str) -> Result<PathBuf, String> {
    let valid = name.ends_with(".getman.yaml")
        && name.len() < 200
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valid {
        return Err(format!("Invalid backup file name: {name}"));
    }
    Ok(PathBuf::from(dir).join(name))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn backup_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Getman").join("backups").to_string_lossy().to_string())
}

#[tauri::command]
pub async fn backup_write(dir: String, name: String, content: String) -> Result<(), String> {
    blocking(move || {
        let path = file_in(&dir, &name)?;
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {dir}: {e}"))?;
        // Write then rename, so a crash never leaves a half-written backup.
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, content).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn backup_list(dir: String) -> Result<Vec<BackupFile>, String> {
    blocking(move || {
        let mut files = vec![];
        let Ok(entries) = fs::read_dir(&dir) else { return Ok(files) };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".getman.yaml") {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            files.push(BackupFile { name, size: meta.len(), modified });
        }
        files.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(files)
    })
    .await
}

#[tauri::command]
pub async fn backup_read(dir: String, name: String) -> Result<String, String> {
    blocking(move || fs::read_to_string(file_in(&dir, &name)?).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn backup_delete(dir: String, name: String) -> Result<(), String> {
    blocking(move || fs::remove_file(file_in(&dir, &name)?).map_err(|e| e.to_string())).await
}

/// Opens the folder in the system file manager.
#[tauri::command]
pub fn open_folder(dir: String) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}
