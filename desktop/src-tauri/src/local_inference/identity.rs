//! Platform-protected machine identities for the direct host bridge.
//!
//! The Windows implementation persists only a DPAPI ciphertext under the
//! current user's application-data directory. macOS and Linux use their native
//! Keychain and Secret Service implementations through `keyring`. There is no
//! plaintext fallback.

#[cfg(windows)]
use std::{fs, path::PathBuf};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

use super::LocalInferenceEnrollmentMaterial;

#[cfg(not(windows))]
const DIRECT_HOST_KEY_SERVICE: &str = "Nessie Desktop Local Inference";
#[cfg(not(windows))]
const DIRECT_HOST_KEY_ACCOUNT: &str = "direct-host-v1";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MachineIdentity {
    pub(super) authorization_revision: u64,
    pub(super) connection_epoch: u64,
    private_key: String,
}

impl MachineIdentity {
    pub(super) fn new(authorization_revision: u64, connection_epoch: u64) -> Self {
        let signing = SigningKey::generate(&mut OsRng);
        Self {
            authorization_revision,
            connection_epoch,
            private_key: URL_SAFE_NO_PAD.encode(signing.to_bytes()),
        }
    }

    pub(super) fn signing_key(&self) -> Result<SigningKey, String> {
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

    pub(super) fn enrollment_material(
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

pub(super) trait MachineIdentityStore {
    fn delete(&self) -> Result<(), String>;
    fn load(&self) -> Result<Option<Vec<u8>>, String>;
    fn store(&self, value: &[u8]) -> Result<(), String>;
}

#[cfg(windows)]
pub(super) struct PlatformMachineIdentityStore {
    path: PathBuf,
}

#[cfg(windows)]
impl PlatformMachineIdentityStore {
    pub(super) fn new(app: &AppHandle) -> Result<Self, String> {
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
pub(super) struct PlatformMachineIdentityStore {
    entry: keyring::Entry,
}

#[cfg(not(windows))]
impl PlatformMachineIdentityStore {
    pub(super) fn new(_app: &AppHandle) -> Result<Self, String> {
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

pub(super) fn identity_from_store(
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

pub(super) fn provision_identity(
    store: &impl MachineIdentityStore,
) -> Result<MachineIdentity, String> {
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

pub(super) fn rotate_identity(
    store: &impl MachineIdentityStore,
) -> Result<MachineIdentity, String> {
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

#[cfg(test)]
mod tests {
    use super::{
        public_key_pem, rotate_identity, save_identity, MachineIdentity, MachineIdentityStore,
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
    fn key_rotation_advances_both_fences_and_replaces_the_public_key() {
        let store = FixtureStore::default();
        let first = MachineIdentity::new(4, 9);
        save_identity(&store, &first).unwrap();
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
