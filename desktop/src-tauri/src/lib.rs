use std::io::{Error, ErrorKind};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;
use tauri::WebviewWindowBuilder;

mod executor_companion;

const DESKTOP_INIT_SCRIPT: &str = concat!(
    include_str!("desktop_notifications_init.js"),
    "\n",
    include_str!("desktop_build_freshness_init.js")
);

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(executor_companion::ExecutorCompanionState::default())
        .invoke_handler(tauri::generate_handler![
            executor_companion::executor_companion_configure_workspace,
            executor_companion::executor_companion_pair,
            executor_companion::executor_companion_start,
            executor_companion::executor_companion_status,
            executor_companion::executor_companion_stop,
        ])
        .setup(|app| {
            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| Error::new(ErrorKind::NotFound, "missing main window config"))?;

            WebviewWindowBuilder::from_config(app.handle(), main_window)?
                .initialization_script(DESKTOP_INIT_SCRIPT)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Nessie Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                executor_companion::shutdown(app.state::<executor_companion::ExecutorCompanionState>().inner());
            }
        });
}
