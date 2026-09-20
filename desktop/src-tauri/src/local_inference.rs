//! The direct Desktop boundary for the owner-host-only local inference lane.
//!
//! This module owns only native state: the per-installation machine key, the
//! configured Nessie origin, and the direct bridge lifecycle. It is neither an
//! HTTP proxy nor a general process launcher. Prompt bytes and private keys
//! never cross the webview boundary.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod identity;

use identity::{
    identity_from_store, provision_identity, rotate_identity, MachineIdentityStore,
    PlatformMachineIdentityStore,
};

const PRODUCTION_ADMIN_ORIGIN: &str = "https://app.nessie.works";
const DEVELOPMENT_ADMIN_ORIGIN: &str = "http://localhost:5455";

#[derive(Default)]
pub struct LocalInferenceState {
    supervisor: Mutex<DirectHostSupervisor>,
}

#[derive(Default)]
struct DirectHostSupervisor {
    /// A direct host is process-bound. It cannot survive a Desktop exit and
    /// must establish a fresh server lease before it may process anything.
    active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceDesktopStatus {
    pub bridge: &'static str,
    pub configured_origin: String,
    pub key: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceEnrollmentMaterial {
    pub authorization_revision: u64,
    pub connection_epoch: u64,
    /// A public Ed25519 SPKI PEM. The private key stays in the protected
    /// native store and is never serialized into an IPC reply.
    pub public_key: String,
    /// Native repair does not claim to revoke the server relationship. The
    /// server must turn this into an explicit re-pair before hosting resumes.
    pub requires_reconsent: bool,
}

fn configured_desktop_origin(debug: bool) -> &'static str {
    if debug {
        DEVELOPMENT_ADMIN_ORIGIN
    } else {
        PRODUCTION_ADMIN_ORIGIN
    }
}

fn canonical_https_origin(value: &str, allow_local_development: bool) -> Result<String, String> {
    let parsed = tauri::Url::parse(value).map_err(|_| {
        "Nessie Desktop could not verify its configured local inference origin.".to_owned()
    })?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.host_str().is_none_or(str::is_empty)
    {
        return Err(
            "Nessie Desktop could not verify its configured local inference origin.".to_owned(),
        );
    }
    let origin = parsed.origin().ascii_serialization();
    if parsed.scheme() == "https" || (allow_local_development && origin == DEVELOPMENT_ADMIN_ORIGIN)
    {
        Ok(origin)
    } else {
        Err("Local inference controls require a TLS-verified Nessie origin.".to_owned())
    }
}

fn assert_local_inference_caller(
    label: &str,
    caller_url: &str,
    configured_origin: &str,
) -> Result<(), String> {
    if label != "main" {
        return Err(
            "Local inference controls are available only from Nessie Desktop's main window."
                .to_owned(),
        );
    }
    let configured = canonical_https_origin(configured_origin, cfg!(debug_assertions))?;
    let caller = tauri::Url::parse(caller_url)
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?
        .origin()
        .ascii_serialization();
    if caller == configured {
        Ok(())
    } else {
        Err(
            "Local inference controls are available only to the configured Nessie origin."
                .to_owned(),
        )
    }
}

fn require_local_inference_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    assert_local_inference_caller(
        webview.label(),
        url.as_str(),
        configured_desktop_origin(cfg!(debug_assertions)),
    )
}

async fn confirm_native(
    app: AppHandle,
    title: &'static str,
    message: &'static str,
    action: &'static str,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                action.to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Desktop could not show its local inference confirmation.".to_owned())
}

fn status(app: &AppHandle, _supervisor: &DirectHostSupervisor) -> LocalInferenceDesktopStatus {
    let key = match PlatformMachineIdentityStore::new(app)
        .and_then(|store| identity_from_store(&store))
    {
        Ok(Some(identity)) if identity.signing_key().is_ok() => "provisioned",
        Ok(None) => "not_provisioned",
        _ => "unavailable",
    };
    LocalInferenceDesktopStatus {
        bridge: "stopped",
        configured_origin: configured_desktop_origin(cfg!(debug_assertions)).to_owned(),
        key,
    }
}

/// Generates/reuses a platform-protected public machine identity only after an
/// OS-native confirmation. It starts no process and makes no network call: the
/// server's signed enrollment/claim protocol is the only later path to a live
/// host lease.
#[tauri::command]
pub async fn local_inference_prepare_desktop_enrollment(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceEnrollmentMaterial, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        "Prepare local Ollama hosting",
        "Nessie Desktop will create a protected machine key for this computer. It does not start Ollama, inspect files, download a model, or send conversation content until you later approve an exact local model binding.",
        "Prepare hosting",
    )
    .await?
    {
        return Err("Preparing local Ollama hosting was cancelled.".to_owned());
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    let identity = provision_identity(&store)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.active = false;
    identity.enrollment_material(false)
}

/// Re-pairing replaces the prior local key before future host traffic may use
/// its successor. The server must perform its corresponding authorization and
/// connection-epoch transition; this command never pretends that it did.
#[tauri::command]
pub async fn local_inference_rotate_machine_key(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceEnrollmentMaterial, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        "Repair local Ollama hosting",
        "Repairing this connection replaces this computer's protected machine key. Existing local model approvals must be confirmed again before this computer can process any conversation content.",
        "Replace key",
    )
    .await?
    {
        return Err("Repairing local Ollama hosting was cancelled.".to_owned());
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    let identity = rotate_identity(&store)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.active = false;
    identity.enrollment_material(true)
}

/// Deleting local protected state is separate from server revocation. It works
/// offline but says nothing false about a prior server relationship.
#[tauri::command]
pub async fn local_inference_forget_local_state(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        "Delete local Ollama state",
        "Delete this computer's protected local Ollama key and cached local state. This does not revoke the server relationship; revoke it separately in Nessie when you are online.",
        "Delete local state",
    )
    .await?
    {
        return Err("Deleting local Ollama state was cancelled.".to_owned());
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    store.delete()?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.active = false;
    Ok(status(&app, &supervisor))
}

#[tauri::command]
pub fn local_inference_desktop_status(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    let supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    Ok(status(&app, &supervisor))
}

pub fn shutdown(state: &LocalInferenceState) {
    if let Ok(mut supervisor) = state.supervisor.lock() {
        supervisor.active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assert_local_inference_caller, canonical_https_origin, DEVELOPMENT_ADMIN_ORIGIN,
        PRODUCTION_ADMIN_ORIGIN,
    };

    #[test]
    fn local_inference_controls_require_the_main_window_and_exact_origin() {
        assert!(assert_local_inference_caller(
            "main",
            "https://app.nessie.works/agents",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_ok());
        assert!(assert_local_inference_caller(
            "document-123",
            "https://app.nessie.works/agents",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
        assert!(assert_local_inference_caller(
            "main",
            "https://evil.example/",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
        assert!(assert_local_inference_caller(
            "main",
            "https://app.nessie.works.evil.example/",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
    }

    #[test]
    fn release_origin_requires_tls_and_an_origin_only() {
        assert_eq!(
            canonical_https_origin(PRODUCTION_ADMIN_ORIGIN, false).unwrap(),
            PRODUCTION_ADMIN_ORIGIN
        );
        assert!(canonical_https_origin("http://app.nessie.works", false).is_err());
        assert!(canonical_https_origin("https://app.nessie.works/path", false).is_err());
        assert!(canonical_https_origin(DEVELOPMENT_ADMIN_ORIGIN, false).is_err());
        assert_eq!(
            canonical_https_origin(DEVELOPMENT_ADMIN_ORIGIN, true).unwrap(),
            DEVELOPMENT_ADMIN_ORIGIN
        );
    }
}
