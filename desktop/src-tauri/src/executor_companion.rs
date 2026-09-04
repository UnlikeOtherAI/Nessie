use std::{collections::BTreeSet, fs, path::PathBuf};

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod runtime;

use runtime::{
    companion_availability, companion_root, daemon_status, executor_state_dir, forget_local_pairing,
    has_executor_state, local_policy_summary, run_configure_workspace, run_pair, start_daemon,
    stop_daemon,
};

#[cfg(not(debug_assertions))]
const PRODUCTION_API_BASE_URL: &str = "https://api.nessie.works";
const WORKSPACE_OPERATION_KEYS: [&str; 5] = [
    "file.list",
    "file.read",
    "file.write",
    "workspace.review",
    "sandbox.stop",
];

pub use runtime::{
    shutdown, ExecutorCompanionAvailability, ExecutorCompanionState, ExecutorCompanionStatus,
};

/// Pairing, starting, stopping and reconfiguring all need a runtime this
/// computer may actually run. The refusal repeats the availability card's own
/// words rather than inventing a second explanation.
fn require_local_control(app: &AppHandle) -> Result<(), String> {
    let (availability, reason) = companion_availability(app);
    if availability.permits_local_control() {
        Ok(())
    } else {
        Err(reason)
    }
}

fn identifier(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(format!("The {field} is malformed."));
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn approved_api_base_url(value: &str) -> Result<&'static str, String> {
    if value == "http://127.0.0.1:5454" {
        Ok("http://127.0.0.1:5454")
    } else {
        Err("A development Nessie Desktop build may pair only with its local API origin.".to_owned())
    }
}

#[cfg(not(debug_assertions))]
fn approved_api_base_url(value: &str) -> Result<&'static str, String> {
    if value == PRODUCTION_API_BASE_URL {
        Ok(PRODUCTION_API_BASE_URL)
    } else {
        Err("This Nessie Desktop release may pair only with its approved API origin.".to_owned())
    }
}

#[cfg(debug_assertions)]
fn assert_approved_companion_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    if url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port_or_known_default() == Some(5455)
    {
        Ok(())
    } else {
        Err("Nessie Desktop companion controls are available only to the approved local admin origin.".to_owned())
    }
}

#[cfg(not(debug_assertions))]
fn assert_approved_companion_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    if url.scheme() == "https"
        && url.host_str() == Some("app.nessie.works")
        && url.port_or_known_default() == Some(443)
    {
        Ok(())
    } else {
        Err("Nessie Desktop companion controls are available only to the approved Nessie admin origin.".to_owned())
    }
}

fn workspace_operation_keys(operation_keys: Vec<String>) -> Result<Vec<String>, String> {
    if operation_keys.is_empty()
        || operation_keys.len() > WORKSPACE_OPERATION_KEYS.len()
        || operation_keys.iter().any(|key| !WORKSPACE_OPERATION_KEYS.contains(&key.as_str()))
    {
        return Err("Choose one or more supported workspace operations.".to_owned());
    }
    let requested = operation_keys.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != operation_keys.len() {
        return Err("Choose each workspace operation only once.".to_owned());
    }
    Ok(WORKSPACE_OPERATION_KEYS
        .iter()
        .filter(|key| requested.contains::<str>(*key))
        .map(|key| (*key).to_owned())
        .collect())
}

async fn confirm(
    app: AppHandle, title: &'static str, message: String, action: &'static str,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(action.to_owned(), "Cancel".to_owned()))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Desktop could not show its native confirmation dialog.".to_owned())
}

async fn choose_workspace(app: AppHandle) -> Result<PathBuf, String> {
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select the executor's read-only workspace")
            .blocking_pick_folder()
            .map(|path| path.into_path())
    })
    .await
    .map_err(|_| "Nessie Desktop could not open its native workspace picker.".to_owned())?;
    selection
        .transpose()
        .map_err(|_| "Nessie Desktop could not resolve the selected workspace.".to_owned())?
        .ok_or_else(|| "Workspace selection was cancelled.".to_owned())
}

/// Only the caller-origin check refuses here. A computer that cannot run the
/// companion answers with the state it is in and the remedy for it, so the
/// Executors panel explains itself instead of rendering nothing.
#[tauri::command]
pub fn executor_companion_status(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
) -> Result<ExecutorCompanionAvailability, String> {
    assert_approved_companion_caller(&webview)?;
    let (availability, reason) = companion_availability(&app);
    let executors = if availability.permits_local_control() {
        paired_executors(&app, &state)
    } else {
        Vec::new()
    };
    Ok(ExecutorCompanionAvailability {
        availability,
        reason,
        platform: crate::shell::desktop_platform(),
        executors,
    })
}

fn paired_executors(
    app: &AppHandle, state: &State<'_, ExecutorCompanionState>,
) -> Vec<ExecutorCompanionStatus> {
    let Ok(root) = companion_root(app) else { return Vec::new(); };
    let Ok(entries) = fs::read_dir(root) else { return Vec::new(); };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let state_dir = entry.path();
        if identifier(&name, "executor id").is_ok() && has_executor_state(&state_dir) {
            if let (Ok(daemon_status), Ok((workspace_label, operation_keys))) = (
                daemon_status(state, &name, &state_dir),
                local_policy_summary(&state_dir),
            ) {
                result.push(ExecutorCompanionStatus {
                    daemon_status,
                    executor_id: name,
                    operation_keys,
                    workspace_configured: true,
                    workspace_label,
                });
            }
        }
    }
    result
}

#[tauri::command]
pub async fn executor_companion_pair(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    api_base_url: String, challenge: String,
    enrollment_id: String, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    let api_base_url = approved_api_base_url(&api_base_url)?;
    identifier(&enrollment_id, "enrollment id")?;
    identifier(&executor_id, "executor id")?;
    if challenge.is_empty() || challenge.len() > 8_192 || challenge.contains('\0') {
        return Err("The pairing challenge is malformed.".to_owned());
    }
    let workspace = choose_workspace(app.clone()).await?;
    if !confirm(
        app.clone(),
        "Pair Nessie executor",
        "Nessie Desktop will create a private machine key and pair this device with Nessie. The selected folder stays under the reviewed local policy. File contents and bounded tool output are sent to Nessie and the configured model provider only when an allowed operation runs.".to_owned(),
        "Pair executor",
    ).await? {
        return Err("Executor pairing was cancelled.".to_owned());
    }
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let api = api_base_url.to_owned();
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let pair_state_dir = state_dir.clone();
        move || run_pair(&app, &api, &enrollment_id, &challenge, &pair_state_dir, &workspace)
    })
    .await
    .map_err(|_| "Nessie Desktop executor pairing stopped unexpectedly.".to_owned())??;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status: "awaiting_confirmation", executor_id,
        operation_keys, workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_start(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    if !confirm(
        app.clone(), "Start Nessie executor",
        "Start this locally paired executor. It can perform only operations that you have reviewed in Nessie and allowed in its local policy.".to_owned(),
        "Start executor",
    ).await? {
        return Err("Starting the executor was cancelled.".to_owned());
    }
    let daemon_status = start_daemon(&app, &state, &executor_id)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_stop(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    if !confirm(
        app.clone(), "Stop Nessie executor",
        "Stopping this executor ends its daemon connection and asks every active browser or coding sandbox to tear down.".to_owned(),
        "Stop executor",
    ).await? {
        return Err("Stopping the executor was cancelled.".to_owned());
    }
    let daemon_status = stop_daemon(&state, &executor_id)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_configure_workspace(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String, operation_keys: Vec<String>,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let operation_keys = workspace_operation_keys(operation_keys)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    if !confirm(
        app.clone(), "Update local executor policy",
        format!(
            "Allow these workspace operations locally: {}. This saves a signed policy revision. A running daemon submits it to Nessie now; a stopped daemon submits it when you next start it. It cannot take effect until a person reviews it in Nessie.",
            operation_keys.join(", "),
        ),
        "Save policy",
    ).await? {
        return Err("Updating the local executor policy was cancelled.".to_owned());
    }
    let was_running = daemon_status(&state, &executor_id, &state_dir)? == "running";
    if was_running { stop_daemon(&state, &executor_id)?; }
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let operation_keys = operation_keys.clone();
        let configure_state_dir = state_dir.clone();
        move || {
            let mut command = runtime::executor_command(&app)?;
            command.args(["configure", "--state-dir"]);
            command.arg(&configure_state_dir);
            command.arg("--operations").arg(operation_keys.join(","));
            if command.status()
                .map_err(|_| "Nessie Desktop could not update the local executor policy.".to_owned())?
                .success()
            { Ok(()) } else { Err("The local executor policy was rejected. No command output was retained.".to_owned()) }
        }
    })
    .await
    .map_err(|_| "Nessie Desktop policy configuration stopped unexpectedly.".to_owned())??;
    let daemon_status = if was_running {
        start_daemon(&app, &state, &executor_id)?
    } else {
        "stopped"
    };
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_change_workspace(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String, operation_keys: Vec<String>,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let operation_keys = workspace_operation_keys(operation_keys)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    let workspace = choose_workspace(app.clone()).await?;
    let workspace_label = workspace.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Selected filesystem root");
    if !confirm(
        app.clone(), "Change executor workspace",
        format!(
            "Use {workspace_label} as this executor's one local workspace folder. The full path stays on this computer. Requested file content and bounded output are sent to Nessie and the configured model provider only when an allowed operation runs. A running daemon submits the new signed revision now; a stopped daemon submits it when you next start it.",
        ),
        "Change workspace",
    ).await? {
        return Err("Changing the executor workspace was cancelled.".to_owned());
    }
    let was_running = daemon_status(&state, &executor_id, &state_dir)? == "running";
    if was_running { stop_daemon(&state, &executor_id)?; }
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let operation_keys = operation_keys.clone();
        move || run_configure_workspace(&app, &state_dir, &workspace, &operation_keys)
    })
    .await
    .map_err(|_| "Nessie Desktop workspace configuration stopped unexpectedly.".to_owned())??;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let daemon_status = if was_running {
        start_daemon(&app, &state, &executor_id)?
    } else {
        "stopped"
    };
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_forget(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String,
) -> Result<(), String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    if !confirm(
        app, "Forget local executor pairing",
        "Remove this computer's machine key and workspace selection, and permanently delete its local draft copies. This does not delete the executor or its audit history in Nessie; its owner must separately revoke any remaining access there.".to_owned(),
        "Forget pairing",
    ).await? {
        return Err("Forgetting the local executor pairing was cancelled.".to_owned());
    }
    match daemon_status(&state, &executor_id, &state_dir)? {
        "running" => { stop_daemon(&state, &executor_id)?; },
        "stopping" => return Err(
            "The local daemon is still stopping. Wait for it to finish before forgetting the pairing.".to_owned(),
        ),
        _ => {},
    }
    forget_local_pairing(&state_dir)
}

#[cfg(test)]
mod tests {
    use super::{approved_api_base_url, identifier, runtime::pair_arguments, workspace_operation_keys};
    use std::path::Path;

    #[test]
    fn accepts_only_safe_executor_identifiers() {
        assert!(identifier("00000000-0000-4000-8000-000000000001", "executor id").is_ok());
        assert!(identifier("../state", "executor id").is_err());
    }

    #[test]
    fn canonicalizes_workspace_policy_without_browser_or_coding_operations() {
        assert_eq!(
            workspace_operation_keys(vec!["sandbox.stop".to_owned(), "file.read".to_owned()]).unwrap(),
            vec!["file.read", "sandbox.stop"],
        );
        assert!(workspace_operation_keys(vec!["browser.open".to_owned()]).is_err());
    }

    #[test]
    fn pairing_arguments_keep_sensitive_input_off_the_process_list() {
        let arguments = pair_arguments(
            "https://api.nessie.works", "00000000-0000-4000-8000-000000000001", Path::new("/private/state"),
        );
        assert!(arguments.contains(&"--pair-input-stdin".to_owned()));
        assert!(!arguments.iter().any(|argument| argument == "secret-challenge"));
        assert!(!arguments.iter().any(|argument| argument == "/private/workspace"));
    }

    #[test]
    fn pairs_only_with_the_approved_api_for_this_build() {
        #[cfg(debug_assertions)]
        {
            assert_eq!(approved_api_base_url("http://127.0.0.1:5454").unwrap(), "http://127.0.0.1:5454");
            assert!(approved_api_base_url("https://api.nessie.works").is_err());
        }
        #[cfg(not(debug_assertions))]
        assert_eq!(approved_api_base_url("https://api.nessie.works").unwrap(), "https://api.nessie.works");
        assert!(approved_api_base_url("https://example.test").is_err());
    }
}
