//! The direct Desktop boundary for the owner-host-only local inference lane.
//!
//! This module owns only native state: the per-installation machine key, the
//! configured Nessie origin, and the direct bridge lifecycle. It is neither an
//! HTTP proxy nor a general process launcher. Prompt bytes and private keys
//! never cross the webview boundary.

use std::{io::Write, process::Stdio, sync::Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod direct_host;
mod identity;
mod origins;

use crate::native_i18n as i18n;
use direct_host::DirectHostSupervisor;
use identity::{
    identity_from_store, provision_identity, rotate_identity, MachineIdentityStore,
    PlatformMachineIdentityStore,
};
use origins::{configured_api_origin, configured_desktop_origin, require_local_inference_caller};

#[derive(Default)]
pub struct LocalInferenceState {
    supervisor: Mutex<DirectHostSupervisor>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceBindingConsent {
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalConsentDisplay {
    account_reference: String,
    agent_label: String,
    host_label: String,
    model_label: String,
    organization_reference: String,
    binding_id: String,
    host_id: String,
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn canonical_consent_display(
    app: &AppHandle,
    identity: &identity::MachineIdentity,
    challenge_id: &str,
    host_id: &str,
    organization_id: &str,
) -> Result<CanonicalConsentDisplay, String> {
    let mut command = crate::executor_companion::executor_command(app)?;
    command.args(["local-inference-consent-display", "--config-stdin"]);
    command.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Nessie Desktop could not fetch the local model confirmation.".to_owned())?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        "Nessie Desktop could not provide local confirmation material securely.".to_owned()
    })?;
    let input = serde_json::json!({
        "apiBaseUrl": configured_api_origin(cfg!(debug_assertions)),
        "connectionEpoch": identity.connection_epoch.to_string(),
        "challengeId": challenge_id,
        "hostId": host_id,
        "machinePrivateKey": identity.private_key_pkcs8_base64url()?,
        "organizationId": organization_id,
        "receiptJournalKey": identity.receipt_journal_key_base64url()?,
    });
    // The service rejects a mismatched organisation from the signed envelope;
    // native does not accept an organisation label or origin from the webview.
    // The host's actual organisation is recovered by the server from its key.
    // (The direct host gets its organisation only from its own enrollment.)
    let serialized = serde_json::to_vec(&input)
        .map_err(|_| "Nessie Desktop could not prepare local confirmation material.".to_owned())?;
    stdin.write_all(&serialized).map_err(|_| {
        "Nessie Desktop could not provide local confirmation material securely.".to_owned()
    })?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|_| "Nessie Desktop could not read the local model confirmation.".to_owned())?;
    if !output.status.success() || output.stdout.len() > 4_096 {
        return Err("Nessie Desktop could not verify the local model confirmation.".to_owned());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "Nessie Desktop could not verify the local model confirmation.".to_owned())
}

async fn confirm_native(
    app: AppHandle,
    language: String,
    title: &str,
    message: &str,
    action: &str,
) -> Result<bool, String> {
    let title = title.to_owned();
    let message = message.to_owned();
    let action = action.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                action,
                i18n::text(&language, "cancel"),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Desktop could not show its local inference confirmation.".to_owned())
}

fn status(app: &AppHandle, supervisor: &mut DirectHostSupervisor) -> LocalInferenceDesktopStatus {
    let key = match PlatformMachineIdentityStore::new(app)
        .and_then(|store| identity_from_store(&store))
    {
        Ok(Some(identity)) if identity.signing_key().is_ok() => "provisioned",
        Ok(None) => "not_provisioned",
        _ => "unavailable",
    };
    LocalInferenceDesktopStatus {
        bridge: if supervisor.is_running() {
            "running"
        } else {
            "stopped"
        },
        configured_origin: configured_desktop_origin(cfg!(debug_assertions)),
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
    language: String,
) -> Result<LocalInferenceEnrollmentMaterial, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        language.clone(),
        &i18n::text(&language, "prepareTitle"),
        &i18n::text(&language, "prepareMessage"),
        &i18n::text(&language, "prepareAction"),
    )
    .await?
    {
        return Err(i18n::text(&language, "prepareCancelled"));
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    let identity = provision_identity(&store)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.stop();
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
    language: String,
) -> Result<LocalInferenceEnrollmentMaterial, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        language.clone(),
        &i18n::text(&language, "rotateTitle"),
        &i18n::text(&language, "rotateMessage"),
        &i18n::text(&language, "rotateAction"),
    )
    .await?
    {
        return Err(i18n::text(&language, "rotateCancelled"));
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    let identity = rotate_identity(&store)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.stop();
    identity.enrollment_material(true)
}

/// Starts the one process Desktop owns for a previously enrolled host. The
/// host and organisation ids are identifiers only; the child can make no API
/// progress unless its protected key proves that exact server host record.
#[tauri::command]
pub async fn local_inference_start_direct_host(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
    host_id: String,
    organization_id: String,
    language: String,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    if !valid_identifier(&host_id) || !valid_identifier(&organization_id) {
        return Err("Nessie Desktop could not verify the local host selection.".to_owned());
    }
    if !confirm_native(
        app.clone(),
        language.clone(),
        &i18n::text(&language, "startTitle"),
        &i18n::text(&language, "startMessage"),
        &i18n::text(&language, "startAction"),
    )
    .await?
    {
        return Err(i18n::text(&language, "startCancelled"));
    }
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.start(&app, &host_id, &organization_id)?;
    Ok(status(&app, &mut supervisor))
}

#[tauri::command]
pub fn local_inference_stop_direct_host(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.stop();
    Ok(status(&app, &mut supervisor))
}

/// Native consent signs only the server-issued exact binding challenge. The
/// browser cannot mint this signature or replace it with a session credential.
#[tauri::command]
pub async fn local_inference_sign_binding_consent(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
    challenge_id: String,
    language: String,
) -> Result<LocalInferenceBindingConsent, String> {
    require_local_inference_caller(&webview)?;
    if !valid_identifier(&challenge_id) {
        return Err("Nessie Desktop could not verify the local model confirmation.".to_owned());
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    let identity = identity_from_store(&store)?
        .ok_or_else(|| "Prepare local Ollama hosting before confirming a model.".to_owned())?;
    let (host_id, organization_id) = {
        let mut supervisor = state
            .supervisor
            .lock()
            .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
        if !supervisor.is_running() {
            return Err(
                "Start this computer's local Ollama host before confirming a model.".to_owned(),
            );
        }
        supervisor.host_context()?
    };
    let shown =
        canonical_consent_display(&app, &identity, &challenge_id, &host_id, &organization_id)?;
    if shown.host_id != host_id || !valid_identifier(&shown.binding_id) {
        return Err("Nessie Desktop could not verify the local model confirmation.".to_owned());
    }
    let message = i18n::format(
        &language,
        "consentMessage",
        &[
            ("organization", &shown.organization_reference),
            ("account", &shown.account_reference),
            ("agent", &shown.agent_label),
            ("model", &shown.model_label),
            ("computer", &shown.host_label),
        ],
    );
    if !confirm_native(
        app.clone(),
        language.clone(),
        &i18n::text(&language, "consentTitle"),
        &message,
        &i18n::text(&language, "consentAction"),
    )
    .await?
    {
        return Err(i18n::text(&language, "consentCancelled"));
    }
    let payload = format!(
        "nessie-local-inference-consent-v1\n{challenge_id}\n{}\n{host_id}",
        shown.binding_id
    );
    Ok(LocalInferenceBindingConsent {
        signature: URL_SAFE_NO_PAD
            .encode(identity.signing_key()?.sign(payload.as_bytes()).to_bytes()),
    })
}

/// Deleting local protected state is separate from server revocation. It works
/// offline but says nothing false about a prior server relationship.
#[tauri::command]
pub async fn local_inference_forget_local_state(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
    language: String,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    if !confirm_native(
        app.clone(),
        language.clone(),
        &i18n::text(&language, "forgetTitle"),
        &i18n::text(&language, "forgetMessage"),
        &i18n::text(&language, "forgetAction"),
    )
    .await?
    {
        return Err(i18n::text(&language, "forgetCancelled"));
    }
    let store = PlatformMachineIdentityStore::new(&app)?;
    store.delete()?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    supervisor.stop();
    Ok(status(&app, &mut supervisor))
}

#[tauri::command]
pub fn local_inference_desktop_status(
    app: AppHandle,
    state: State<'_, LocalInferenceState>,
    webview: WebviewWindow,
) -> Result<LocalInferenceDesktopStatus, String> {
    require_local_inference_caller(&webview)?;
    let mut supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "Nessie Desktop local inference state is unavailable.".to_owned())?;
    Ok(status(&app, &mut supervisor))
}

pub fn shutdown(state: &LocalInferenceState) {
    if let Ok(mut supervisor) = state.supervisor.lock() {
        supervisor.stop();
    }
}
