//! The direct-update bridge is deliberately compiled only into the downloads
//! published from GitHub. Store builds omit both this module and the updater
//! plugin, so Apple or Google remain the sole update authority there.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The hosted admin only needs enough metadata to make the person's decision.
/// The pending signed `Update` itself never crosses the webview boundary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    body: Option<String>,
}

pub struct PendingUpdate(Mutex<Option<Update>>);

pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
}

#[tauri::command]
pub async fn desktop_direct_update_check(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let metadata = update.as_ref().map(|update| UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
    });

    *pending_update
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable.".to_owned())? = update;

    Ok(metadata)
}

#[tauri::command]
pub async fn desktop_direct_update_install(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending_update
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable.".to_owned())?
        .take()
        .ok_or_else(|| "There is no checked update to install.".to_owned())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;

    // NSIS closes the process while installing. macOS and AppImage builds need
    // the explicit restart to start the newly verified bundle.
    app.restart();
}
