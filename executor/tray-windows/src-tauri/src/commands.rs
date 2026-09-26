//! What the tray can do, in one place.
//!
//! The right-click menu and the status window are two ways of reaching the same
//! actions, so they call these functions rather than each carrying their own
//! copy — a second implementation of "stop this executor" is exactly the kind
//! of fork that ends with two surfaces disagreeing about what a confirmation
//! says.
//!
//! Every mutation confirms in a native dialog first, the way the desktop
//! companion does, and every refusal is shown in the service's own words.
//!
//! The CLI is the only writer of executor state. On Windows the service holds
//! the owner-only state directory, so the tray cannot run `nessie-executor`
//! directly: it asks the service over the control pipe, and the service runs
//! the CLI. That still keeps the tray from ever parsing or writing
//! `executor-state.json` itself.

use nessie_windows_common::LOGS_DIRECTORY;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::{
    description::ExecutorDescription,
    pairing_origin,
    permitted_command,
    pipe_client::{call, ServiceResponse},
    service_identity::{executors_url_for_api, service_root},
    state::ServiceView,
    workspace_folder,
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

/// Reads the credential-free `nessie-executor describe` projection for one
/// executor through the service. The tray never opens `executor-state.json`.
pub fn describe(executor_id: &str) -> Result<ExecutorDescription, String> {
    let response = call(&serde_json::json!({
        "command": "describe",
        "executorId": executor_id,
    }))?;
    match response {
        ServiceResponse::Describe(value) => serde_json::from_value(value)
            .map_err(|_| "the service answered in a shape this tray does not understand".to_owned()),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
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
    let response = call(&serde_json::json!({ "command": "start", "executorId": executor_id }))?;
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
    let response = call(&serde_json::json!({ "command": "stop", "executorId": executor_id }))?;
    match response {
        ServiceResponse::Status(executors) => Ok(ServiceView::Reachable { executors }),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
    }
}

/// Builds a new configuration by reading the current description, applying a
/// mutation that has already been validated, and asking the service to run
/// `configure --configuration-input-stdin`. Re-stating every field means a
/// section that changes one thing cannot silently narrow the parts it is not
/// editing.
async fn reconfigure<R: Runtime, F: FnOnce(&mut ExecutorDescription)>(
    app: AppHandle<R>,
    executor_id: String,
    title: &'static str,
    message: String,
    action: &'static str,
    mutate: F,
) -> Result<ExecutorDescription, String> {
    if !confirm(app, title, message, action).await? {
        return Err("The change was cancelled.".to_owned());
    }
    let mut description = describe(&executor_id)?;
    mutate(&mut description);
    let response = call(&serde_json::json!({
        "command": "configureInput",
        "executorId": executor_id,
        "configurationInput": description.configuration_input(),
    }))?;
    match response {
        ServiceResponse::Status(_) => Ok(describe(&executor_id)?),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
    }
}

pub async fn add_folder<R: Runtime>(
    app: AppHandle<R>,
    executor_id: String,
    path: String,
) -> Result<ExecutorDescription, String> {
    let trimmed = path.trim().to_owned();
    let description = describe(&executor_id)?;
    let folders = workspace_folder::validate_adding(&trimmed, None, &description.reach.folders)?;
    reconfigure(
        app,
        executor_id,
        "Add a workspace folder",
        format!("Add {trimmed} to the folders this executor may read. The change writes a new local policy revision and takes effect only after a person reviews it in Nessie."),
        "Add folder",
        |description| description.reach.folders = folders.clone(),
    )
    .await
}

pub async fn remove_folder<R: Runtime>(
    app: AppHandle<R>,
    executor_id: String,
    name: String,
) -> Result<ExecutorDescription, String> {
    let description = describe(&executor_id)?;
    let folders = workspace_folder::validate_removing(&name, &description.reach.folders)?;
    reconfigure(
        app,
        executor_id,
        "Remove a workspace folder",
        format!("Remove the '{name}' folder from the folders this executor may read. The change writes a new local policy revision and takes effect only after a person reviews it in Nessie."),
        "Remove folder",
        |description| description.reach.folders = folders.clone(),
    )
    .await
}

pub async fn add_command<R: Runtime>(
    app: AppHandle<R>,
    executor_id: String,
    command: String,
) -> Result<ExecutorDescription, String> {
    let trimmed = command.trim().to_owned();
    let description = describe(&executor_id)?;
    let programs = permitted_command::validate_adding(&trimmed, &description.policy.permitted_programs)?;
    reconfigure(
        app,
        executor_id,
        "Add a permitted command",
        format!("Add '{trimmed}' to the commands this executor may run. The change writes a new local policy revision and takes effect only after a person reviews it in Nessie."),
        "Add command",
        |description| description.policy.permitted_programs = programs.clone(),
    )
    .await
}

pub async fn remove_command<R: Runtime>(
    app: AppHandle<R>,
    executor_id: String,
    command: String,
) -> Result<ExecutorDescription, String> {
    let trimmed = command.trim().to_owned();
    let description = describe(&executor_id)?;
    let programs = permitted_command::validate_removing(
        &trimmed,
        &description.policy.permitted_programs,
        description.command_run_enabled(),
    )?;
    reconfigure(
        app,
        executor_id,
        "Remove a permitted command",
        format!("Remove '{trimmed}' from the commands this executor may run. The change writes a new local policy revision and takes effect only after a person reviews it in Nessie."),
        "Remove command",
        |description| description.policy.permitted_programs = programs.clone(),
    )
    .await
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
pub async fn executor_describe(executor_id: String) -> Result<ExecutorDescription, String> {
    describe(&executor_id)
}

#[tauri::command]
pub async fn executor_add_folder(app: AppHandle, executor_id: String, path: String) -> Result<ExecutorDescription, String> {
    add_folder(app, executor_id, path).await
}

#[tauri::command]
pub async fn executor_remove_folder(app: AppHandle, executor_id: String, name: String) -> Result<ExecutorDescription, String> {
    remove_folder(app, executor_id, name).await
}

#[tauri::command]
pub async fn executor_add_command(app: AppHandle, executor_id: String, command: String) -> Result<ExecutorDescription, String> {
    add_command(app, executor_id, command).await
}

#[tauri::command]
pub async fn executor_remove_command(app: AppHandle, executor_id: String, command: String) -> Result<ExecutorDescription, String> {
    remove_command(app, executor_id, command).await
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
