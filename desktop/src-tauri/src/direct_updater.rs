//! The direct-update bridge is deliberately compiled only into the downloads
//! published from GitHub. Store builds omit both this module and the updater
//! plugin, so Apple or Google remain the sole update authority there.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const PREFERENCE_FILE: &str = "direct-desktop-update-preference.json";
const REMIND_AFTER_MS: u64 = 24 * 60 * 60 * 1000;

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

/// This lives in native app data, rather than the hosted admin's storage. A
/// person can therefore clear website data without resetting an update choice.
#[derive(Default, Deserialize, Serialize)]
struct UpdatePreference {
    remind_after: Option<u64>,
    remind_version: Option<String>,
    skipped_version: Option<String>,
}

fn preference_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(PREFERENCE_FILE))
        .map_err(|error| error.to_string())
}

fn read_preference(app: &AppHandle) -> Result<UpdatePreference, String> {
    let path = preference_path(app)?;
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(UpdatePreference::default()),
        Err(error) => return Err(error.to_string()),
    };
    // A corrupted preference is never a reason to suppress a verified update.
    Ok(serde_json::from_str(&value).unwrap_or_default())
}

fn write_preference(app: &AppHandle, preference: &UpdatePreference) -> Result<(), String> {
    let path = preference_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "The updater preference directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let value = serde_json::to_vec(preference).map_err(|error| error.to_string())?;
    fs::write(path, value).map_err(|error| error.to_string())
}

fn now_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .map_err(|error| error.to_string())
}

fn should_offer_update(preference: &UpdatePreference, version: &str, now: u64) -> bool {
    preference.skipped_version.as_deref() != Some(version)
        && !(preference.remind_version.as_deref() == Some(version)
            && preference
                .remind_after
                .is_some_and(|remind_after| remind_after > now))
}

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

    let metadata = if let Some(update) = update.as_ref() {
        let preference = read_preference(&app)?;
        if should_offer_update(&preference, &update.version, now_millis()?) {
            Some(UpdateMetadata {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                body: update.body.clone(),
            })
        } else {
            None
        }
    } else {
        None
    };

    *pending_update
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable.".to_owned())? =
        if metadata.is_some() { update } else { None };

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

fn record_preference(
    app: &AppHandle,
    pending_update: &PendingUpdate,
    version: &str,
    preference: UpdatePreference,
) -> Result<(), String> {
    let mut pending = pending_update
        .0
        .lock()
        .map_err(|_| "The updater state is unavailable.".to_owned())?;
    if pending.as_ref().map(|update| update.version.as_str()) != Some(version) {
        return Err("That update is no longer available.".to_owned());
    }
    write_preference(app, &preference)?;
    *pending = None;
    Ok(())
}

#[tauri::command]
pub fn desktop_direct_update_skip(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), String> {
    record_preference(
        &app,
        &pending_update,
        &version,
        UpdatePreference {
            skipped_version: Some(version.clone()),
            ..Default::default()
        },
    )
}

#[tauri::command]
pub fn desktop_direct_update_remind(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), String> {
    record_preference(
        &app,
        &pending_update,
        &version,
        UpdatePreference {
            remind_after: Some(now_millis()?.saturating_add(REMIND_AFTER_MS)),
            remind_version: Some(version.clone()),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{should_offer_update, UpdatePreference, REMIND_AFTER_MS};

    #[test]
    fn a_skipped_version_does_not_hide_a_later_update() {
        let preference = UpdatePreference {
            skipped_version: Some("0.1.1".to_owned()),
            ..Default::default()
        };
        assert!(!should_offer_update(&preference, "0.1.1", 100));
        assert!(should_offer_update(&preference, "0.1.2", 100));
    }

    #[test]
    fn a_reminder_expires_for_its_own_version_only() {
        let preference = UpdatePreference {
            remind_after: Some(100 + REMIND_AFTER_MS),
            remind_version: Some("0.1.1".to_owned()),
            ..Default::default()
        };
        assert!(!should_offer_update(&preference, "0.1.1", 100));
        assert!(should_offer_update(
            &preference,
            "0.1.1",
            100 + REMIND_AFTER_MS
        ));
        assert!(should_offer_update(&preference, "0.1.2", 100));
    }
}
