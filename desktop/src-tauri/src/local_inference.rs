//! The direct Desktop boundary for the owner-host-only local inference lane.
//!
//! This module deliberately owns only native state: the per-installation
//! machine key, the currently configured Nessie origin and the direct bridge
//! lifecycle.  It is not an HTTP proxy, process launcher, or a substitute for
//! the server's signed host protocol.  In particular, prompt bytes and the
//! private key never cross the webview boundary.

use std::sync::Mutex;

#[cfg(windows)]
use std::{fs, path::PathBuf};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[cfg(not(windows))]
const DIRECT_HOST_KEY_SERVICE: &str = "Nessie Desktop Local Inference";
#[cfg(not(windows))]
const DIRECT_HOST_KEY_ACCOUNT: &str = "direct-host-v1";
const PRODUCTION_ADMIN_ORIGIN: &str = "https://app.nessie.works";
const DEVELOPMENT_ADMIN_ORIGIN: &str = "http://localhost:5455";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Default)]
pub struct LocalInferenceState {
    supervisor: Mutex<DirectHostSupervisor>,
}

#[derive(Default)]
struct DirectHostSupervisor {
    /// A direct host is process-bound.  It cannot survive a desktop exit and
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
    /// A public Ed25519 SPKI PEM. The corresponding private key remains in
    /// the protected native store and is never serialized into an IPC reply.
    pub public_key: String,
    /// Native key repair intentionally does not claim to revoke a server
    /// relationship. The server must consume this as an explicit re-pair and
    /// mark every old binding unavailable until the owner consents again.
    pub requires_reconsent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineIdentity {
    authorization_revision: u64,
    connection_epoch: u64,
    private_key: String,
}

impl MachineIdentity {
    fn new(authorization_revision: u64, connection_epoch: u64) -> Self {
        let signing = SigningKey::generate(&mut OsRng);
        Self {
            authorization_revision,
            connection_epoch,
            private_key: URL_SAFE_NO_PAD.encode(signing.to_bytes()),
        }
    }

    fn signing_key(&self) -> Result<SigningKey, String> {
        let bytes = URL_SAFE_NO_PAD.decode(&self.private_key).map_err(|_| {
            "Nessie Desktop's protected local inference key is malformed.".to_owned()
        })?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
            "Nessie Desktop's protected local inference key is malformed.".to_owned()
        })?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    fn public_key_pem(&self) -> Result<String, String> {
        let verifying = self.signing_key()?.verifying_key();
        public_key_pem(&verifying)
    }

    fn enrollment_material(
        &self,
        requires_reconsent: bool,
    ) -> Result<LocalInferenceEnrollmentMaterial, String> {
        Ok(LocalInferenceEnrollmentMaterial {
            authorization_revision: self.authorization_revision,
            connection_epoch: self.connection_epoch,
            public_key: self.public_key_pem()?,
            requires_reconsent,
        })
    }
}

fn public_key_pem(verifying: &VerifyingKey) -> Result<String, String> {
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend(verifying.as_bytes());
    let encoded = STANDARD.encode(der);
    if encoded.len() > 8_192 {
        return Err("Nessie Desktop could not encode its local inference public key.".to_owned());
    }
    let body = encoded
        .as_bytes()
        .chunks(64)
        .map(std::str::from_utf8)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Nessie Desktop could not encode its local inference public key.".to_owned())?
        .join("\n");
    Ok(format!(
        "-----BEGIN PUBLIC KEY-----\n{body}\n-----END PUBLIC KEY-----\n"
    ))
}

trait MachineIdentityStore {
    fn delete(&self) -> Result<(), String>;
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn store(&self, value: &[u8]) -> Result<(), String>;
}

#[cfg(windows)]
struct PlatformMachineIdentityStore {
    path: PathBuf,
}

#[cfg(windows)]
impl PlatformMachineIdentityStore {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| {
                "Nessie Desktop could not resolve protected local inference storage.".to_owned()
            })?
            .join("local-inference");
        fs::create_dir_all(&root).map_err(|_| {
            "Nessie Desktop could not prepare protected local inference storage.".to_owned()
        })?;
        let metadata = fs::symlink_metadata(&root).map_err(|_| {
            "Nessie Desktop could not verify protected local inference storage.".to_owned()
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Nessie Desktop local inference storage must be an ordinary directory.".to_owned(),
            );
        }
        Ok(Self {
            path: root.join("machine-identity.dpapi"),
        })
    }

    fn encrypted_file(&self) -> Result<Option<Vec<u8>>, String> {
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(
                        "Nessie Desktop local inference storage must be an ordinary file."
                            .to_owned(),
                    );
                }
                fs::read(&self.path).map(Some).map_err(|_| {
                    "Nessie Desktop could not read protected local inference storage.".to_owned()
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => {
                Err("Nessie Desktop could not verify protected local inference storage.".to_owned())
            }
        }
    }
}

#[cfg(windows)]
impl MachineIdentityStore for PlatformMachineIdentityStore {
    fn delete(&self) -> Result<(), String> {
        match self.encrypted_file()? {
            Some(_) => fs::remove_file(&self.path).map_err(|_| {
                "Nessie Desktop could not remove its protected local inference key.".to_owned()
            }),
            None => Ok(()),
        }
    }

    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        self.encrypted_file()?.map(dpapi_unprotect).transpose()
    }

    fn store(&self, value: &[u8]) -> Result<(), String> {
        let encrypted = dpapi_protect(value)?;
        fs::write(&self.path, encrypted).map_err(|_| {
            "Nessie Desktop could not write protected local inference storage.".to_owned()
        })
    }
}

#[cfg(windows)]
fn dpapi_protect(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = blob(value)?;
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    copy_then_free_blob(succeeded != 0, &mut output)
}

#[cfg(windows)]
fn dpapi_unprotect(value: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = blob(&value)?;
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    copy_then_free_blob(succeeded != 0, &mut output)
}

#[cfg(windows)]
fn blob(
    value: &[u8],
) -> Result<windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB, String> {
    let length: u32 = value
        .len()
        .try_into()
        .map_err(|_| "Nessie Desktop local inference key data is too large.".to_owned())?;
    Ok(
        windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: value.as_ptr().cast_mut(),
        },
    )
}

#[cfg(windows)]
fn copy_then_free_blob(
    succeeded: bool,
    output: &mut windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;

    if !succeeded || output.pbData.is_null() {
        return Err(
            "Nessie Desktop could not access the current user's protected local inference key."
                .to_owned(),
        );
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    output.pbData = std::ptr::null_mut();
    Ok(result)
}

#[cfg(not(windows))]
struct PlatformMachineIdentityStore {
    entry: keyring::Entry,
}

#[cfg(not(windows))]
impl PlatformMachineIdentityStore {
    fn new(_app: &AppHandle) -> Result<Self, String> {
        keyring::Entry::new(DIRECT_HOST_KEY_SERVICE, DIRECT_HOST_KEY_ACCOUNT)
            .map(|entry| Self { entry })
            .map_err(|_| {
                "Nessie Desktop could not access the platform secure store for local inference."
                    .to_owned()
            })
    }
}

#[cfg(not(windows))]
impl MachineIdentityStore for PlatformMachineIdentityStore {
    fn delete(&self) -> Result<(), String> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => {
                Err("Nessie Desktop could not remove its protected local inference key.".to_owned())
            }
        }
    }

    fn load(&self) -> Result<Option<Vec<u8>>, String> {
        match self.entry.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(
                "Nessie Desktop could not access the platform secure store for local inference."
                    .to_owned(),
            ),
        }
    }

    fn store(&self, value: &[u8]) -> Result<(), String> {
        self.entry.set_secret(value).map_err(|_| {
            "Nessie Desktop could not save the protected local inference key.".to_owned()
        })
    }
}

fn identity_from_store(
    store: &impl MachineIdentityStore,
) -> Result<Option<MachineIdentity>, String> {
    store
        .load()?
        .map(|bytes| {
            serde_json::from_slice(&bytes).map_err(|_| {
                "Nessie Desktop's protected local inference key is malformed.".to_owned()
            })
        })
        .transpose()
}

fn save_identity(
    store: &impl MachineIdentityStore,
    identity: &MachineIdentity,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(identity).map_err(|_| {
        "Nessie Desktop could not prepare its protected local inference key.".to_owned()
    })?;
    store.store(&encoded)
}

fn provision_identity(store: &impl MachineIdentityStore) -> Result<MachineIdentity, String> {
    match identity_from_store(store)? {
        Some(identity) => {
            identity.signing_key()?;
            Ok(identity)
        }
        None => {
            let identity = MachineIdentity::new(1, 1);
            save_identity(store, &identity)?;
            Ok(identity)
        }
    }
}

fn rotate_identity(store: &impl MachineIdentityStore) -> Result<MachineIdentity, String> {
    let previous = identity_from_store(store)?
        .ok_or_else(|| "Nessie Desktop has no local inference key to repair.".to_owned())?;
    previous.signing_key()?;
    let authorization_revision =
        previous
            .authorization_revision
            .checked_add(1)
            .ok_or_else(|| {
                "Nessie Desktop local inference authorization revision is exhausted.".to_owned()
            })?;
    let connection_epoch = previous.connection_epoch.checked_add(1).ok_or_else(|| {
        "Nessie Desktop local inference connection epoch is exhausted.".to_owned()
    })?;
    let replacement = MachineIdentity::new(authorization_revision, connection_epoch);
    save_identity(store, &replacement)?;
    Ok(replacement)
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
    ).await? {
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

/// Re-pairing destroys the prior local key before future host traffic may use
/// the replacement. The server must perform its corresponding authorization
/// and connection-epoch transition; this command never pretends that it did.
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
    ).await? {
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

/// Deleting local protected state is intentionally separate from server
/// revocation. It remains useful while offline, but says nothing false about
/// whether the server still knows a prior host until the caller revokes it.
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
    ).await? {
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
        assert_local_inference_caller, canonical_https_origin, public_key_pem, rotate_identity,
        MachineIdentity, MachineIdentityStore, DEVELOPMENT_ADMIN_ORIGIN, PRODUCTION_ADMIN_ORIGIN,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::SigningKey;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FixtureStore(Mutex<Option<Vec<u8>>>);

    impl MachineIdentityStore for FixtureStore {
        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }

        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn store(&self, value: &[u8]) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(value.to_vec());
            Ok(())
        }
    }

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

    #[test]
    fn key_rotation_advances_both_fences_and_replaces_the_public_key() {
        let store = FixtureStore::default();
        let first = MachineIdentity::new(4, 9);
        super::save_identity(&store, &first).unwrap();
        let replacement = rotate_identity(&store).unwrap();
        assert_eq!(replacement.authorization_revision, 5);
        assert_eq!(replacement.connection_epoch, 10);
        assert_ne!(
            replacement.public_key_pem().unwrap(),
            first.public_key_pem().unwrap()
        );
    }

    #[test]
    fn exported_public_key_is_a_standard_ed25519_spki_pem() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let public = public_key_pem(&signing.verifying_key()).unwrap();
        assert!(public.starts_with("-----BEGIN PUBLIC KEY-----\n"));
        assert!(public.ends_with("-----END PUBLIC KEY-----\n"));
        assert!(
            !public.contains(&URL_SAFE_NO_PAD.encode([7; 32])),
            "a private seed must not appear in the public export",
        );
    }
}
