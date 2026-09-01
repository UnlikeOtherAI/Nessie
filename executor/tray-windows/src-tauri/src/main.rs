// A tray application must never flash a console window at login.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! `nessie-executor-tray.exe` — the Nessie Executor's control surface beside the
//! Windows clock.
//!
//! It starts at login, shows no window, and polls the service over its control
//! pipe. Right-click gives the menu; left-click opens a small frameless status
//! window that offers the same actions through the same functions. It holds no
//! state and no credential of its own: everything it shows came from the
//! service in the last three seconds, and everything it changes goes back over
//! the pipe.
//!
//! It has one other mode, which it invokes on itself: `--grant-workspace <path>`
//! is the elevated half of pairing.

mod commands;
mod grant;
mod invitation;
mod menu;
mod pipe_client;
mod service_identity;
mod state;

use std::time::Duration;

use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

use menu::{parse_menu_id, MenuAction};
use state::{tray_state, ServiceView};

const TRAY_ID: &str = "nessie-executor";

/// How often the tray asks the service what is true. Short enough that starting
/// a daemon turns the icon green while the person is still looking at it, long
/// enough to cost nothing.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

fn apply(app: &AppHandle, view: &ServiceView) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(icon) = Image::from_bytes(tray_state(view).icon_bytes()) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(state::header_label(view)));
    if let Ok(menu) = menu::build(app, view) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The poll runs off the main thread and the tray is updated on it: menus are a
/// main-thread object on Windows.
fn start_polling(app: AppHandle) {
    std::thread::spawn(move || loop {
        let view = commands::view();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || apply(&handle, &view));
        std::thread::sleep(POLL_INTERVAL);
    });
}

fn refresh_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let view = commands::view();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || apply(&handle, &view));
    });
}

/// Menu clicks arrive on the main thread, and every one of these actions opens
/// a modal dialog, so each is handed to the async runtime rather than blocking
/// the thread that has to draw it.
fn handle_menu(app: &AppHandle, id: &str) {
    match parse_menu_id(id) {
        MenuAction::Start(executor_id) => spawn_action(app, "Start Nessie executor", {
            let app = app.clone();
            async move { commands::start(app, executor_id).await.map(|_| ()) }
        }),
        MenuAction::Stop(executor_id) => spawn_action(app, "Stop Nessie executor", {
            let app = app.clone();
            async move { commands::stop(app, executor_id).await.map(|_| ()) }
        }),
        // Pairing needs a text field, so it opens the status window on its pair
        // form rather than trying to be a dialog.
        MenuAction::Pair => {
            commands::show_status(app);
            let _ = app.emit_to("status", "tray://pair", ());
        }
        MenuAction::OpenNessie => report(app, "Open Nessie", commands::open_nessie(app)),
        MenuAction::OpenLogs => report(app, "Open logs folder", commands::open_logs(app)),
        // Only this process exits. The service, and every daemon it supervises,
        // keeps running — which is what the menu entry says it will do.
        MenuAction::Quit => app.exit(0),
        MenuAction::Unknown => {}
    }
}

fn spawn_action(
    app: &AppHandle,
    title: &'static str,
    action: impl std::future::Future<Output = Result<(), String>> + Send + 'static,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = action.await;
        report(&app, title, outcome);
        refresh_now(&app);
    });
}

fn report(app: &AppHandle, title: &'static str, outcome: Result<(), String>) {
    if let Err(reason) = outcome {
        commands::notify(app, title, reason);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let view = ServiceView::Unreachable { reason: "checking…".to_owned() };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(tray_state(&view).icon_bytes())?)
        .tooltip(state::header_label(&view))
        .menu(&menu::build(app, &view)?)
        // Without this, a left-click opens the menu and the status window is
        // unreachable.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, ..
            } = event
            {
                commands::show_status(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let [switch, path] = arguments.as_slice() {
        if switch == grant::GRANT_SWITCH {
            // The elevated half of pairing: grant one directory, record this
            // account, exit. It shows no window and never becomes the tray.
            if let Err(reason) = grant::grant_workspace(std::path::Path::new(path)) {
                eprintln!("{reason}");
                std::process::exit(1);
            }
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::executor_hide_status,
            commands::executor_open_logs,
            commands::executor_open_nessie,
            commands::executor_pair,
            commands::executor_start,
            commands::executor_stop,
            commands::executor_view,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            start_polling(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Nessie Executor tray could not start");
}
