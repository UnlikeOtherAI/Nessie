//! Pairing is machine-first. The code is display-only; the service keeps the key.
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::{
    pairing_origin,
    pipe_client::{call, ServiceResponse},
};

fn request(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    match call(&payload)? {
        ServiceResponse::Pairing(view) => Ok(view),
        _ => Err("Nessie could not read the pairing status.".to_owned()),
    }
}

#[tauri::command]
pub async fn executor_pairing_start(
    app: AppHandle,
    workspace_root: String,
    replace: bool,
    api_base_url: String,
) -> Result<serde_json::Value, String> {
    let origin = pairing_origin::approve(&api_base_url, cfg!(debug_assertions))?.origin;
    let workspace = PathBuf::from(&workspace_root);
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err("Choose the folder this computer may read.".to_owned());
    }
    if replace {
        let current = request(serde_json::json!({ "command": "pairingStatus" }))?;
        let organisation = current
            .get("organizationName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Nessie");
        let team = current
            .get("teamName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("No team");
        let approved = app.dialog().message(format!("This computer is paired to {organisation}, {team}. Close that pairing and create a new one?"))
            .title("Replace pairing").buttons(MessageDialogButtons::OkCancelCustom("Replace pairing".to_owned(), "Cancel".to_owned()))
            .blocking_show();
        if !approved {
            return Err("Pairing was cancelled.".to_owned());
        }
    }
    tauri::async_runtime::spawn_blocking(move || request(serde_json::json!({
        "command": "pairingStart", "apiBaseUrl": origin, "workspaceRoot": workspace_root, "replace": replace,
    }))).await.map_err(|_| "Pairing could not be started.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_status(executor_id: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(serde_json::json!({ "command": "pairingStatus", "executorId": executor_id }))
    })
    .await
    .map_err(|_| "Pairing status could not be read.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_cancel() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        request(serde_json::json!({ "command": "pairingCancel" }))
    })
    .await
    .map_err(|_| "Pairing could not be cancelled.".to_owned())?
}

#[tauri::command]
pub async fn executor_pairing_confirm(claim_digest: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(serde_json::json!({
            "command": "pairingConfirm", "claimDigest": claim_digest,
        }))
    })
    .await
    .map_err(|_| "Pairing could not be confirmed.".to_owned())?
}
