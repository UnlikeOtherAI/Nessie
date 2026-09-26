//! What the tray can do, in one place.
//!
//! The right-click menu and the status window are two ways of reaching the same
//! actions, so they call these functions rather than each carrying their own
//! copy — a second implementation of "stop this executor" is exactly the kind
//! of fork that ends with two surfaces disagreeing about what a confirmation
//! says.
//!
//! The CLI is the only reader and writer of private executor state. New
//! connections run under this user's account; existing service connections
//! are addressed through the authenticated pipe. Resource edits live in
//! console_commands and use the CLI's complete local configuration contract.

use nessie_windows_common::LOGS_DIRECTORY;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::{
    pairing_origin,
    pipe_client::{call, ServiceResponse},
    service_identity::{executors_url_for_api, service_root},
    state::ServiceView,
};

/// The service's answer, with a failure turned into the view that says so
/// rather than into an empty list.
pub fn view() -> ServiceView {
    match call(&serde_json::json!({ "command": "status" })) {
        Ok(ServiceResponse::Status(executors)) => ServiceView::Reachable { executors },
        Ok(_) => ServiceView::Unreachable {
            reason: "the service answered in a shape this tray does not understand".to_owned(),
        },
        Err(reason) => ServiceView::Unreachable { reason },
    }
}

async fn confirm<R: Runtime>(
    app: AppHandle<R>,
    title: &'static str,
    message: String,
    action: &'static str,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(action.to_owned(), "Cancel".to_owned()))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Executor could not show its confirmation dialog.".to_owned())
}

/// A refusal a person did not ask for by clicking something in a window still
/// has to reach them; the menu has nowhere to render one.
pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &'static str, message: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(message).title(title).blocking_show();
    });
}

pub async fn start<R: Runtime>(app: AppHandle<R>, executor_id: String) -> Result<ServiceView, String> {
    if !confirm(
        app,
        "Start Nessie executor",
        "Start this locally paired executor with the permissions configured on this computer."
            .to_owned(),
        "Start executor",
    )
    .await?
    {
        return Err("Starting the executor was cancelled.".to_owned());
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        call(&serde_json::json!({ "command": "start", "executorId": executor_id }))
    }).await.map_err(|error| error.to_string())??;
    match response {
        ServiceResponse::Status(executors) => Ok(ServiceView::Reachable { executors }),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
    }
}

pub async fn stop<R: Runtime>(app: AppHandle<R>, executor_id: String) -> Result<ServiceView, String> {
    if !confirm(
        app,
        "Stop Nessie executor",
        "Stopping this executor ends its daemon connection and asks every active browser or \
         coding sandbox to tear down."
            .to_owned(),
        "Stop executor",
    )
    .await?
    {
        return Err("Stopping the executor was cancelled.".to_owned());
    }
    let response = tauri::async_runtime::spawn_blocking(move || {
        call(&serde_json::json!({ "command": "stop", "executorId": executor_id }))
    }).await.map_err(|error| error.to_string())??;
    match response {
        ServiceResponse::Status(executors) => Ok(ServiceView::Reachable { executors }),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
    }
}

fn executors_url_for_backend(backend: &str) -> Result<&'static str, String> {
    let origin = pairing_origin::resolve(backend, None, cfg!(debug_assertions))?;
    executors_url_for_api(&origin.origin)
}

pub fn open_nessie<R: Runtime>(app: &AppHandle<R>, backend: &str) -> Result<(), String> {
    app.opener()
        .open_url(executors_url_for_backend(backend)?, None::<&str>)
        .map_err(|_| "Nessie Executor could not open your browser.".to_owned())
}

pub fn open_logs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let logs = service_root()?.join(LOGS_DIRECTORY);
    // The service creates the folder when it first writes to it; opening a path
    // that is not there yet would show a shell error instead of an explanation.
    if !logs.is_dir() {
        return Err("The Nessie Executor service has not written any logs yet.".to_owned());
    }
    app.opener()
        .open_path(logs.display().to_string(), None::<&str>)
        .map_err(|_| "Nessie Executor could not open the logs folder.".to_owned())
}

/// The status window is created hidden at launch so a left-click shows it
/// immediately; there is no main window at any point.
pub fn show_status<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub async fn choose_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let file_path = app
            .dialog()
            .file()
            .set_title("Choose a folder this executor may read")
            .blocking_pick_folder()?;
        file_path
            .into_path()
            .ok()
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|_| "Nessie Executor could not open its folder picker.".to_owned())?)
}

#[tauri::command]
pub async fn executor_view() -> Result<ServiceView, String> {
    tauri::async_runtime::spawn_blocking(view).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn executor_start(app: AppHandle, executor_id: String) -> Result<ServiceView, String> {
    start(app, executor_id).await
}

#[tauri::command]
pub async fn executor_stop(app: AppHandle, executor_id: String) -> Result<ServiceView, String> {
    stop(app, executor_id).await
}

#[tauri::command]
pub fn executor_open_nessie(app: AppHandle, api_base_url: String) -> Result<(), String> {
    open_nessie(&app, &api_base_url)
}

#[cfg(test)]
mod open_nessie_tests {
    use super::executors_url_for_backend;

    #[test]
    fn the_status_window_nessie_preset_resolves_before_opening() {
        assert_eq!(
            executors_url_for_backend("nessie"),
            Ok("https://app.nessie.works/admin/computers"),
        );
    }
}

#[tauri::command]
pub fn executor_pairing_backends() -> Vec<(&'static str, &'static str)> {
    pairing_origin::backend_choices(cfg!(debug_assertions))
}

#[tauri::command]
pub fn executor_open_logs(app: AppHandle) -> Result<(), String> {
    open_logs(&app)
}

#[tauri::command]
pub fn executor_hide_status(app: AppHandle) {
    if let Some(window) = app.get_webview_window("status") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub async fn executor_choose_folder(app: AppHandle) -> Result<Option<String>, String> {
    choose_folder(app).await
}
