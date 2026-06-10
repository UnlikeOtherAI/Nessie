use std::io::{Error, ErrorKind};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;
use tauri::WebviewWindowBuilder;

const DESKTOP_NOTIFICATIONS_INIT_SCRIPT: &str = include_str!("desktop_notifications_init.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| Error::new(ErrorKind::NotFound, "missing main window config"))?;

            WebviewWindowBuilder::from_config(app.handle(), main_window)?
                .initialization_script(DESKTOP_NOTIFICATIONS_INIT_SCRIPT)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
