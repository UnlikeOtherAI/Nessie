//! What the tray can do, in one place.
//!
//! The right-click menu and the status window are two ways of reaching the same
//! five actions, so they call these functions rather than each carrying their
//! own copy — a second implementation of "stop this executor" is exactly the
//! kind of fork that ends with two surfaces disagreeing about what a
//! confirmation says.
//!
//! Every mutation confirms in a native dialog first, the way the desktop
//! companion does, and every refusal is shown in the service's own words.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::{
    grant::request_workspace_grant,
    invitation::parse_invitation,
    pipe_client::call,
    service_identity::{EXECUTORS_URL, LOGS_DIRECTORY, SERVICE_ACCOUNT, SERVICE_DIRECTORY_NAME},
    state::ServiceView,
};

/// The service's answer, with a failure turned into the view that says so
/// rather than into an empty list.
pub fn view() -> ServiceView {
    match call(&serde_json::json!({ "command": "status" })) {
        Ok(executors) => ServiceView::Reachable { executors },
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
        "Start this locally paired executor. It can perform only operations that you have \
         reviewed in Nessie and allowed in its local policy."
            .to_owned(),
        "Start executor",
    )
    .await?
    {
        return Err("Starting the executor was cancelled.".to_owned());
    }
    let executors = call(&serde_json::json!({ "command": "start", "executorId": executor_id }))?;
    Ok(ServiceView::Reachable { executors })
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
    let executors = call(&serde_json::json!({ "command": "stop", "executorId": executor_id }))?;
    Ok(ServiceView::Reachable { executors })
}

async fn choose_workspace<R: Runtime>(app: AppHandle<R>) -> Result<PathBuf, String> {
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select the executor's read-only workspace")
            .blocking_pick_folder()
            .map(|path| path.into_path())
    })
    .await
    .map_err(|_| "Nessie Executor could not open its workspace picker.".to_owned())?;
    selection
        .transpose()
        .map_err(|_| "Nessie Executor could not resolve the selected workspace.".to_owned())?
        .ok_or_else(|| "Workspace selection was cancelled.".to_owned())
}

/// Pairing, in the order the design fixes: read the invitation, choose the
/// workspace, confirm, grant the service account access to that workspace
/// through one elevated relaunch, then hand the challenge to the service over
/// the pipe. The challenge never reaches a command line, and the elevated step
/// is what admits this account to the pipe from then on.
pub async fn pair<R: Runtime>(app: AppHandle<R>, invitation: String) -> Result<ServiceView, String> {
    let invitation = parse_invitation(&invitation)?;
    let workspace = choose_workspace(app.clone()).await?;
    if !confirm(
        app,
        "Pair Nessie executor",
        format!(
            "Nessie Executor will create a private machine key and pair this computer with \
             Nessie. Windows will ask for administrator approval once, to give the {SERVICE_ACCOUNT} \
             service account access to the workspace you chose. The workspace stays on this \
             computer and is used only through the executor's reviewed policy.",
        ),
        "Pair executor",
    )
    .await?
    {
        return Err("Executor pairing was cancelled.".to_owned());
    }
    let elevated = workspace.clone();
    tauri::async_runtime::spawn_blocking(move || request_workspace_grant(&elevated))
        .await
        .map_err(|_| "Granting workspace access stopped unexpectedly.".to_owned())??;
    let executors = call(&serde_json::json!({
        "command": "pair",
        "apiBaseUrl": invitation.api_base_url,
        "challenge": invitation.challenge,
        "enrollmentId": invitation.enrollment_id,
        "workspaceRoot": workspace.display().to_string(),
    }))?;
    Ok(ServiceView::Reachable { executors })
}

pub fn open_nessie<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.opener()
        .open_url(EXECUTORS_URL, None::<&str>)
        .map_err(|_| "Nessie Executor could not open your browser.".to_owned())
}

pub fn open_logs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "Windows reported no ProgramData directory.".to_owned())?;
    let logs = PathBuf::from(program_data).join(SERVICE_DIRECTORY_NAME).join(LOGS_DIRECTORY);
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

#[tauri::command]
pub fn executor_view() -> ServiceView {
    view()
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
pub async fn executor_pair(app: AppHandle, invitation: String) -> Result<ServiceView, String> {
    pair(app, invitation).await
}

#[tauri::command]
pub fn executor_open_nessie(app: AppHandle) -> Result<(), String> {
    open_nessie(&app)
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
