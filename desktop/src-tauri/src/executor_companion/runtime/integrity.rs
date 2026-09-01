use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

/// Every file the packaged executor companion is made of. The presence check,
/// the hash manifest and the Linux ownership check all read this one list.
pub(crate) const RUNTIME_FILES: [&str; 4] =
    ["node", "nessie-executor.cjs", "manifest.json", "NODE_LICENSE"];

#[cfg(all(not(debug_assertions), target_os = "macos"))]
const PRODUCTION_SIGNING_TEAM_ID: Option<&str> = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID");

#[cfg(any(test, all(not(debug_assertions), target_os = "linux")))]
pub(crate) const PACKAGE_INSTALL_REASON: &str =
    "Executor controls need Nessie installed from the Nessie package, so an administrator owns \
     its executor runtime.";

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    executor_bundle_sha256: String,
    format: u8,
    node_sha256: String,
}

/// The packaged runtime directory, verified for completeness, integrity, and
/// release provenance. Callers that only need a message use
/// [`super::runtime_directory`].
pub(crate) fn verified_runtime_directory(app: &AppHandle) -> Result<PathBuf, RuntimeUnavailable> {
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
    for name in RUNTIME_FILES {
        let candidate = root.join(name);
        let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
            RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is unavailable.")
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RuntimeUnavailable::missing(
                "Nessie Desktop's packaged executor companion is invalid.",
            ));
        }
    }
    let manifest: RuntimeManifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).map_err(|_| {
            RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is invalid.")
        })?,
    )
    .map_err(|_| {
        RuntimeUnavailable::missing("Nessie Desktop's packaged executor companion is invalid.")
    })?;
    if manifest.format != 1
        || manifest.node_sha256 != file_sha256(&root.join("node"))?
        || manifest.executor_bundle_sha256 != file_sha256(&root.join("nessie-executor.cjs"))?
    {
        return Err(RuntimeUnavailable::missing(
            "Nessie Desktop's packaged executor companion did not pass integrity verification.",
        ));
    }
    require_release_signature(app, &root).map_err(RuntimeUnavailable::unsigned)?;
    Ok(root)
}

#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn require_release_signature(_app: &AppHandle, resource_dir: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let expected_team = PRODUCTION_SIGNING_TEAM_ID
        .filter(|team| !team.is_empty() && team.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .ok_or_else(|| {
            "Executor controls require a release build with a pinned Developer ID team.".to_owned()
        })?;
    let bundle = application_bundle_from_resource_dir(resource_dir)?;
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Nessie Desktop could not verify its release signature.".to_owned())?
        .success();
    if !verified {
        return Err("Executor controls require a signed, intact Nessie Desktop release.".to_owned());
    }
    let metadata = Command::new("/usr/bin/codesign")
        .args(["-dvv"])
        .arg(bundle)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Nessie Desktop could not inspect its release signature.".to_owned())?;
    let details = String::from_utf8_lossy(&metadata.stderr);
    if details.lines().any(|line| line == format!("TeamIdentifier={expected_team}"))
        && details.lines().any(|line| line.starts_with("Authority=Developer ID Application:"))
    {
        Ok(())
    } else {
        Err("Executor controls require the pinned Developer ID signature.".to_owned())
    }
}

/// Linux has no OS-held code signature to read at runtime. Its trust root is the
/// package manager: only an administrator can install a root-owned tree under
/// `/usr`, so a user-writable copy — an AppImage, a build in a home directory —
/// runs the shell but never gets executor controls.
#[cfg(all(not(debug_assertions), target_os = "linux"))]
fn require_release_signature(_app: &AppHandle, resource_dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let root = fs::canonicalize(resource_dir).map_err(|_| PACKAGE_INSTALL_REASON.to_owned())?;
    if !is_package_manager_path(&root) {
        return Err(PACKAGE_INSTALL_REASON.to_owned());
    }
    for path in std::iter::once(root.clone()).chain(RUNTIME_FILES.iter().map(|name| root.join(name)))
    {
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| PACKAGE_INSTALL_REASON.to_owned())?;
        if !is_administrator_owned(metadata.uid(), metadata.mode()) {
            return Err(PACKAGE_INSTALL_REASON.to_owned());
        }
    }
    Ok(())
}

#[cfg(all(not(debug_assertions), not(any(target_os = "macos", target_os = "linux"))))]
fn require_release_signature(_app: &AppHandle, resource_dir: &Path) -> Result<(), String> {
    let _ = resource_dir;
    Err(crate::executor_companion::runtime::availability::UNSUPPORTED_PLATFORM_REASON.to_owned())
}

#[cfg(debug_assertions)]
fn require_release_signature(_app: &AppHandle, _resource_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// A package-manager install, and only that: `Path::starts_with` compares whole
/// components, so `/usr/libexec` is not under `/usr/lib`.
#[cfg(any(test, all(not(debug_assertions), target_os = "linux")))]
pub(crate) fn is_package_manager_path(path: &Path) -> bool {
    path.starts_with("/usr/lib") || path.starts_with("/usr/share")
}

/// Owned by uid 0 and writable by nobody else. Group- or world-writable defeats
/// the whole trust root: anyone in that group could replace the runtime.
#[cfg(any(test, all(not(debug_assertions), target_os = "linux")))]
pub(crate) fn is_administrator_owned(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

#[cfg(any(test, all(not(debug_assertions), target_os = "macos")))]
pub(crate) fn application_bundle_from_resource_dir(resource_dir: &Path) -> Result<&Path, String> {
    resource_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "Nessie Desktop could not locate its application bundle.".to_owned())
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
        application_bundle_from_resource_dir, is_administrator_owned, is_package_manager_path,
        PACKAGE_INSTALL_REASON,
    };
    use std::path::Path;

    #[test]
    fn the_linux_refusal_names_the_remedy_and_no_local_path() {
        assert!(PACKAGE_INSTALL_REASON.contains("Nessie package"));
        assert!(!PACKAGE_INSTALL_REASON.contains('/'));
    }

    #[test]
    fn release_signature_checks_the_application_bundle_not_its_contents_directory() {
        assert_eq!(
            application_bundle_from_resource_dir(Path::new(
                "/Applications/Nessie.app/Contents/Resources/executor-runtime",
            ))
            .unwrap(),
            Path::new("/Applications/Nessie.app"),
        );
    }

    #[test]
    fn accepts_only_a_package_manager_install_prefix() {
        assert!(is_package_manager_path(Path::new("/usr/lib/Nessie/executor-runtime")));
        assert!(is_package_manager_path(Path::new("/usr/share/nessie/executor-runtime")));
        assert!(!is_package_manager_path(Path::new("/usr/libexec/Nessie/executor-runtime")));
        assert!(!is_package_manager_path(Path::new("/home/person/Nessie/executor-runtime")));
        assert!(!is_package_manager_path(Path::new("/tmp/.mount_Nessie/usr/lib")));
        assert!(!is_package_manager_path(Path::new("/opt/nessie/executor-runtime")));
    }

    #[test]
    fn requires_root_ownership_and_refuses_a_shared_write_bit() {
        assert!(is_administrator_owned(0, 0o755));
        assert!(is_administrator_owned(0, 0o644));
        assert!(!is_administrator_owned(1000, 0o755));
        assert!(!is_administrator_owned(0, 0o775));
        assert!(!is_administrator_owned(0, 0o777));
        assert!(!is_administrator_owned(0, 0o646));
    }

    /// The predicate above is the decision; this proves it reads a real file's
    /// metadata the way the Linux arm does. It needs a root-owned file, so it
    /// states what it could not prove rather than passing vacuously.
    #[cfg(target_os = "linux")]
    #[test]
    fn reads_ownership_from_real_file_metadata() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = std::env::temp_dir().join(format!(
            "nessie-integrity-{}-{}",
            std::process::id(),
            "ownership",
        ));
        std::fs::create_dir_all(&directory).expect("the test directory must be creatable");
        let path = directory.join("node");
        std::fs::write(&path, b"binary").expect("the test file must be writable");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))
            .expect("the test file mode must be settable");
        let metadata = std::fs::symlink_metadata(&path).expect("metadata must be readable");
        assert!(!is_administrator_owned(metadata.uid(), metadata.mode()));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("the test file mode must be settable");
        let metadata = std::fs::symlink_metadata(&path).expect("metadata must be readable");
        if metadata.uid() == 0 {
            assert!(is_administrator_owned(metadata.uid(), metadata.mode()));
        } else {
            eprintln!(
                "skipping the accepted-ownership half: this test does not run as root (uid {})",
                metadata.uid(),
            );
        }
        std::fs::remove_dir_all(&directory).ok();
    }
}
