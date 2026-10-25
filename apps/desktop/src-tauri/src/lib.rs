mod git;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            git::git_version,
            git::git_status,
            git::git_pull,
            git::git_commit_push,
            git::git_clone,
            git::git_init,
            git::getman_read,
            git::getman_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Getman");
}
