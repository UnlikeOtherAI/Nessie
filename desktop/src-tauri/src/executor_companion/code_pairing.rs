//! Each account uses the shared code-pairing workflow and its own machine key.
use std::{fs, process::Stdio};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{approved_api_base_url, assert_approved_companion_caller, choose_workspace, confirm, require_local_control};
use super::runtime::{executor_command, executor_state_dir, start_daemon, ExecutorCompanionState};

fn run(app: &AppHandle, action: &str, arguments: &[String]) -> Result<serde_json::Value, String> {
    let directory = executor_state_dir(app, "pairing")?;
    let output = executor_command(app)?
        .args([format!("pairing-{action}"), "--json".to_owned(), "--state-dir".to_owned()])
        .arg(&directory).args(arguments).stderr(Stdio::null()).output()
        .map_err(|_| "Nessie could not start pairing.".to_owned())?;
    if !output.status.success() { return Err("Pairing could not finish. Check the connection and try again.".to_owned()); }
    serde_json::from_slice(&output.stdout).map_err(|_| "Pairing returned an unreadable response.".to_owned())
}

fn check(app: &AppHandle, webview: &WebviewWindow) -> Result<(), String> {
    assert_approved_companion_caller(webview)?;
    require_local_control(app)?;
    if crate::shell::desktop_platform() == "macos" {
        return Err("Open Nessie Executor in the menu bar and choose Add account.".to_owned());
    }
    Ok(())
}

fn complete(app: &AppHandle, state: &ExecutorCompanionState, view: &serde_json::Value) -> Result<(), String> {
    let id = view.get("executorId").and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Pairing did not return a connection.".to_owned())?;
    let destination = executor_state_dir(app, id)?;
    if destination.exists() { return Err("That connection already exists.".to_owned()); }
    fs::rename(executor_state_dir(app, "pairing")?, destination)
        .map_err(|_| "Nessie could not save this connection.".to_owned())?;
    start_daemon(app, state, id).map(|_| ())
}

#[tauri::command]
pub async fn executor_companion_pairing_start(
    app: AppHandle, webview: WebviewWindow, api_base_url: String,
) -> Result<String, String> {
    check(&app, &webview)?;
    let origin = approved_api_base_url(&api_base_url)?;
    let workspace = choose_workspace(app.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExecutorCompanionState>();
        let _guard = state.pairing.lock().map_err(|_| "Pairing is unavailable.".to_owned())?;
        let arguments = [
            "--api".to_owned(), origin, "--workspace".to_owned(), workspace.to_string_lossy().into_owned(),
        ];
        let mut view = run(&app, "start", &arguments)?;
        if view.get("status").and_then(serde_json::Value::as_str) == Some("alreadyPaired") {
            complete(&app, &state, &view)?;
            view = run(&app, "start", &arguments)?;
        }
        view.get("code").and_then(serde_json::Value::as_str).map(str::to_owned)
            .ok_or_else(|| "Finish or cancel the current pairing before starting another.".to_owned())
    }).await.map_err(|_| "Pairing stopped unexpectedly.".to_owned())?
}

#[tauri::command]
pub async fn executor_companion_pairing_cancel(app: AppHandle, webview: WebviewWindow) -> Result<(), String> {
    check(&app, &webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExecutorCompanionState>();
        let _guard = state.pairing.lock().map_err(|_| "Pairing is unavailable.".to_owned())?;
        run(&app, "cancel", &[]).map(|_| ())
    }).await.map_err(|_| "Pairing stopped unexpectedly.".to_owned())?
}

#[tauri::command]
pub async fn executor_companion_pairing_confirm(app: AppHandle, webview: WebviewWindow) -> Result<(), String> {
    check(&app, &webview)?;
    let view = tauri::async_runtime::spawn_blocking({ let app = app.clone(); move || {
        let state = app.state::<ExecutorCompanionState>();
        let _guard = state.pairing.lock().map_err(|_| "Pairing is unavailable.".to_owned())?;
        let view = run(&app, "status", &[])?;
        if view.get("status").and_then(serde_json::Value::as_str) == Some("paired") { complete(&app, &state, &view)?; }
        Ok::<_, String>(view)
    } })
        .await.map_err(|_| "Pairing stopped unexpectedly.".to_owned())??;
    if view.get("status").and_then(serde_json::Value::as_str) == Some("paired") { return Ok(()); }
    let digest = view.get("claimDigest").and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Review and claim this code in Nessie first.".to_owned())?.to_owned();
    let organisation = view.get("organizationName").and_then(serde_json::Value::as_str).unwrap_or("Nessie");
    let team = view.get("teamName").and_then(serde_json::Value::as_str).unwrap_or("No team");
    let origin = view.get("apiBaseUrl").and_then(serde_json::Value::as_str).unwrap_or("");
    if !confirm(app.clone(), "Add Nessie account", format!("Connect this computer to {organisation}, {team}, at {origin}? Existing connections stay online."), "Connect").await? {
        return Err("Connection was not confirmed.".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ExecutorCompanionState>();
        let _guard = state.pairing.lock().map_err(|_| "Pairing is unavailable.".to_owned())?;
        let paired = run(&app, "confirm", &["--claim-digest".to_owned(), digest])?;
        complete(&app, &state, &paired)
    }).await.map_err(|_| "Pairing stopped unexpectedly.".to_owned())?
}
