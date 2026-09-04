use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

mod provenance;

use provenance::require_release_signature;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// The files present in every package, whatever the host built it. The Node
/// binary and the optional native helper are named by the manifest instead,
/// because their file names differ per host and a reader must never guess one
/// from the platform it happens to be running on.
pub(crate) const RUNTIME_FIXED_FILES: [&str; 3] =
    ["nessie-executor.cjs", "manifest.json", "NODE_LICENSE"];

/// The only two names the packaged Node binary may have.
pub(crate) const NODE_EXECUTABLES: [&str; 2] = ["node", "node.exe"];

/// The only two names the packaged native helper may have.
pub(crate) const NATIVE_HELPERS: [&str; 2] =
    ["nessie-executor-native", "nessie-executor-native.exe"];

#[derive(Clone, Copy)]
struct RuntimePins {
    executor_bundle_sha256: Option<&'static str>,
    native_helper_sha256: Option<&'static str>,
    node_sha256: Option<&'static str>,
}

/// Windows installs the desktop per-user, so the resource directory is not a
/// trust boundary. The release workflow compiles the exact runtime hashes into
/// the signed application executable; the adjacent manifest must agree with
/// that signed copy before it can name anything we launch.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
const WINDOWS_RELEASE_RUNTIME_PINS: RuntimePins = RuntimePins {
    executor_bundle_sha256: option_env!("NESSIE_DESKTOP_EXECUTOR_BUNDLE_SHA256"),
    native_helper_sha256: option_env!(
        "NESSIE_DESKTOP_EXECUTOR_NATIVE_HELPER_SHA256"
    ),
    node_sha256: option_env!("NESSIE_DESKTOP_EXECUTOR_NODE_SHA256"),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeFailureKind {
    /// The packaged runtime is absent, malformed, or fails its hash manifest.
    Missing,
    /// The runtime is intact but this install is not a verified release.
    Unsigned,
}

#[derive(Debug)]
pub(crate) struct RuntimeUnavailable {
    pub kind: RuntimeFailureKind,
    /// Person-readable and remedy-naming. Never a local path, key, or the
    /// output of a child process.
    pub reason: String,
}

impl RuntimeUnavailable {
    fn missing(reason: &str) -> Self {
        Self { kind: RuntimeFailureKind::Missing, reason: reason.to_owned() }
    }

    fn unsigned(reason: String) -> Self {
        Self { kind: RuntimeFailureKind::Unsigned, reason }
    }
}

/// Serde ignores keys it does not know, which is why `nodeExecutable` could be
/// added without moving off `format: 1`: an older reader still verifies
/// everything format 1 ever promised. This reader requires it, because the one
/// producer that writes this manifest always writes it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    executor_bundle_sha256: String,
    format: u8,
    native_helper: Option<String>,
    native_helper_sha256: Option<String>,
    node_executable: String,
    node_sha256: String,
}

/// A verified packaged runtime and the host-shaped file names it declared.
pub(crate) struct VerifiedRuntime {
    /// The packaged Node binary's file name — `node` or `node.exe`.
    pub node_executable: String,
    pub root: PathBuf,
}

/// A manifest names files, never paths: only the known literals are accepted,
/// so a rewritten manifest cannot point the companion at a binary of its own
/// choosing somewhere else on disk.
fn packaged_name(candidates: &[&str], declared: &str) -> Option<String> {
    candidates.iter().find(|name| **name == declared).map(|name| (*name).to_owned())
}

/// The packaged runtime directory, verified for completeness, integrity, and
/// release provenance. Callers that only need a message use
/// [`super::runtime_directory`].
pub(crate) fn verified_runtime_directory(
    app: &AppHandle,
) -> Result<VerifiedRuntime, RuntimeUnavailable> {
    #[cfg(debug_assertions)]
    let root = {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/executor-runtime")
    };
    #[cfg(not(debug_assertions))]
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| {
            RuntimeUnavailable::missing(
                "Nessie Desktop could not find its packaged executor companion.",
            )
        })?
        .join("executor-runtime");
    for name in RUNTIME_FIXED_FILES {
        require_ordinary_file(&root, name)?;
    }
    let manifest: RuntimeManifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).map_err(|_| {
            RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is invalid.")
        })?,
    )
    .map_err(|_| {
        RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is invalid.")
    })?;
    let invalid = || {
        RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is invalid.")
    };
    let node_executable =
        packaged_name(&NODE_EXECUTABLES, &manifest.node_executable).ok_or_else(invalid)?;
    let native_helper = match (&manifest.native_helper, &manifest.native_helper_sha256) {
        (None, None) => None,
        (Some(name), Some(_)) => Some(packaged_name(&NATIVE_HELPERS, name).ok_or_else(invalid)?),
        _ => return Err(invalid()),
    };
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    require_windows_runtime_pins(&manifest, WINDOWS_RELEASE_RUNTIME_PINS)?;
    let mut packaged: Vec<String> = vec![node_executable.clone()];
    if let Some(helper) = &native_helper {
        packaged.push(helper.clone());
    }
    for name in &packaged {
        require_ordinary_file(&root, name)?;
    }
    let helper_intact = match (&native_helper, &manifest.native_helper_sha256) {
        (Some(helper), Some(digest)) => *digest == file_sha256(&root.join(helper))?,
        _ => true,
    };
    if manifest.format != 1
        || !helper_intact
        || manifest.node_sha256 != file_sha256(&root.join(&node_executable))?
        || manifest.executor_bundle_sha256 != file_sha256(&root.join("nessie-executor.cjs"))?
    {
        return Err(RuntimeUnavailable::missing(
            "Nessie Desktop's packaged executor companion did not pass integrity verification.",
        ));
    }
    require_release_signature(app, &root, &packaged).map_err(RuntimeUnavailable::unsigned)?;
    Ok(VerifiedRuntime { node_executable, root })
}

fn require_windows_runtime_pins(
    manifest: &RuntimeManifest,
    pins: RuntimePins,
) -> Result<(), RuntimeUnavailable> {
    let (Some(executor_bundle), Some(native_helper), Some(node)) = (
        pins.executor_bundle_sha256,
        pins.native_helper_sha256,
        pins.node_sha256,
    ) else {
        return Err(RuntimeUnavailable::unsigned(
            "Executor controls require a release build with a pinned Windows runtime.".to_owned(),
        ));
    };
    if !valid_sha256(executor_bundle) || !valid_sha256(native_helper) || !valid_sha256(node) {
        return Err(RuntimeUnavailable::unsigned(
            "Executor controls require a release build with a valid pinned Windows runtime."
                .to_owned(),
        ));
    }
    if manifest.node_executable != "node.exe"
        || manifest.native_helper.as_deref() != Some("nessie-executor-native.exe")
        || manifest.executor_bundle_sha256 != executor_bundle
        || manifest.native_helper_sha256.as_deref() != Some(native_helper)
        || manifest.node_sha256 != node
    {
        return Err(RuntimeUnavailable::missing(
            "Nessie Desktop's packaged executor companion does not match this signed release.",
        ));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn require_ordinary_file(root: &Path, name: &str) -> Result<(), RuntimeUnavailable> {
    let metadata = fs::symlink_metadata(root.join(name)).map_err(|_| {
        RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is unavailable.")
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(RuntimeUnavailable::missing(
            "Nessie Desktop's packaged executor companion is invalid.",
        ));
    }
    Ok(())
}


fn file_sha256(path: &Path) -> Result<String, RuntimeUnavailable> {
    let mut file = File::open(path).map_err(|_| {
        RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is unavailable.")
    })?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer).map_err(|_| {
            RuntimeUnavailable::missing(
                "Nessie Desktop could not verify its packaged executor companion.",
            )
        })?;
        if read == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        packaged_name, require_windows_runtime_pins, RuntimeFailureKind, RuntimeManifest,
        RuntimePins, NATIVE_HELPERS, NODE_EXECUTABLES,
    };

    const BUNDLE_DIGEST: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";
    const HELPER_DIGEST: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";
    const NODE_DIGEST: &str =
        "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    fn windows_manifest() -> RuntimeManifest {
        RuntimeManifest {
            executor_bundle_sha256: BUNDLE_DIGEST.to_owned(),
            format: 1,
            native_helper: Some("nessie-executor-native.exe".to_owned()),
            native_helper_sha256: Some(HELPER_DIGEST.to_owned()),
            node_executable: "node.exe".to_owned(),
            node_sha256: NODE_DIGEST.to_owned(),
        }
    }

    fn windows_pins() -> RuntimePins {
        RuntimePins {
            executor_bundle_sha256: Some(BUNDLE_DIGEST),
            native_helper_sha256: Some(HELPER_DIGEST),
            node_sha256: Some(NODE_DIGEST),
        }
    }

    /// A manifest names a file, never a path: this is what stops a rewritten
    /// manifest from pointing the companion at a binary of its own choosing.
    #[test]
    fn only_the_known_packaged_file_names_are_accepted() {
        assert_eq!(packaged_name(&NODE_EXECUTABLES, "node").as_deref(), Some("node"));
        assert_eq!(packaged_name(&NODE_EXECUTABLES, "node.exe").as_deref(), Some("node.exe"));
        for declared in ["", "Node", "node.bin", "../node", "/usr/bin/node", r"..\node.exe"] {
            assert_eq!(
                packaged_name(&NODE_EXECUTABLES, declared),
                None,
                "node executable {declared:?} must be refused",
            );
        }
        assert_eq!(
            packaged_name(&NATIVE_HELPERS, "nessie-executor-native.exe").as_deref(),
            Some("nessie-executor-native.exe"),
        );
        assert_eq!(packaged_name(&NATIVE_HELPERS, "cmd.exe"), None);
    }

    #[test]
    fn signed_windows_runtime_accepts_only_the_compiled_hashes() {
        require_windows_runtime_pins(&windows_manifest(), windows_pins()).unwrap();

        let mut replaced = windows_manifest();
        replaced.executor_bundle_sha256 = "3".repeat(64);
        let failure = require_windows_runtime_pins(&replaced, windows_pins()).unwrap_err();
        assert_eq!(failure.kind, RuntimeFailureKind::Missing);
        assert!(failure.reason.contains("does not match this signed release"));
        assert!(!failure.reason.contains('\\'));
    }

    #[test]
    fn release_without_complete_valid_windows_pins_is_unsigned() {
        for pins in [
            RuntimePins {
                executor_bundle_sha256: None,
                ..windows_pins()
            },
            RuntimePins {
                node_sha256: Some("not-a-sha256"),
                ..windows_pins()
            },
        ] {
            let failure = require_windows_runtime_pins(&windows_manifest(), pins).unwrap_err();
            assert_eq!(failure.kind, RuntimeFailureKind::Unsigned);
            assert!(failure.reason.contains("pinned Windows runtime"));
            assert!(!failure.reason.contains('\\'));
        }
    }

    #[test]
    fn windows_pin_requires_the_windows_runtime_shape() {
        let mut manifest = windows_manifest();
        manifest.node_executable = "node".to_owned();
        let failure = require_windows_runtime_pins(&manifest, windows_pins()).unwrap_err();
        assert_eq!(failure.kind, RuntimeFailureKind::Missing);

        let mut manifest = windows_manifest();
        manifest.native_helper = None;
        manifest.native_helper_sha256 = None;
        let failure = require_windows_runtime_pins(&manifest, windows_pins()).unwrap_err();
        assert_eq!(failure.kind, RuntimeFailureKind::Missing);
    }
}
