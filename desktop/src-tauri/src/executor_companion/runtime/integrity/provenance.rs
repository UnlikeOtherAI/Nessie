//! Release provenance: is this build a release from the publisher we pinned?
//!
//! Separate from the packaged-runtime hash manifest beside it, and deliberately
//! so: a manifest is a self-attestation — whoever can rewrite the binary can
//! rewrite the manifest — so the trust root has to be something the operating
//! system holds and a user cannot forge. macOS reads `codesign` and a pinned
//! Developer ID team, Windows reads Authenticode and a pinned publisher
//! thumbprint — the same decision the executor service and tray make, so it is
//! taken from `nessie-windows-provenance` rather than restated here — and
//! Linux, which has no in-process signature to read, reads the package
//! manager's own evidence: a root-owned tree only an administrator can lay
//! down.

#[cfg(all(not(debug_assertions), target_os = "linux"))]
use std::fs;
use std::path::Path;

use tauri::AppHandle;

#[cfg(all(not(debug_assertions), target_os = "macos"))]
const PRODUCTION_SIGNING_TEAM_ID: Option<&str> = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID");

/// The Windows analogue of the pinned Developer ID team: the SHA-1 thumbprint
/// of the certificate the release is signed with, compiled into the build.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
const PRODUCTION_WINDOWS_SIGNER_THUMBPRINT: Option<&str> =
    option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT");

#[cfg(any(test, all(not(debug_assertions), target_os = "linux")))]
pub(crate) const PACKAGE_INSTALL_REASON: &str =
    "Executor controls need Nessie installed from the Nessie package, so an administrator owns \
     its executor runtime.";

#[cfg(all(not(debug_assertions), target_os = "macos"))]
pub(super) fn require_release_signature(
    _app: &AppHandle,
    resource_dir: &Path,
    _packaged: &[String],
) -> Result<(), String> {
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
pub(super) fn require_release_signature(
    _app: &AppHandle,
    resource_dir: &Path,
    packaged: &[String],
) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let root = fs::canonicalize(resource_dir).map_err(|_| PACKAGE_INSTALL_REASON.to_owned())?;
    if !is_package_manager_path(&root) {
        return Err(PACKAGE_INSTALL_REASON.to_owned());
    }
    let names = super::RUNTIME_FIXED_FILES
        .iter()
        .map(|name| root.join(name))
        .chain(packaged.iter().map(|name| root.join(name)));
    for path in std::iter::once(root.clone()).chain(names)
    {
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| PACKAGE_INSTALL_REASON.to_owned())?;
        if !is_administrator_owned(metadata.uid(), metadata.mode()) {
            return Err(PACKAGE_INSTALL_REASON.to_owned());
        }
    }
    Ok(())
}

/// Windows binds executor controls to Authenticode plus a pinned publisher.
/// `WinVerifyTrust` alone answers only "trusted", never "by whom" — any valid
/// code-signing certificate passes it — so the signer read out of the
/// verification state is compared to the thumbprint compiled into the release.
#[cfg(all(not(debug_assertions), target_os = "windows"))]
pub(super) fn require_release_signature(
    _app: &AppHandle,
    resource_dir: &Path,
    _packaged: &[String],
) -> Result<(), String> {
    let _ = resource_dir;
    nessie_windows_provenance::require_release_signature(PRODUCTION_WINDOWS_SIGNER_THUMBPRINT)
}

#[cfg(all(not(debug_assertions), not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "windows"
))))]
pub(super) fn require_release_signature(
    _app: &AppHandle,
    resource_dir: &Path,
    _packaged: &[String],
) -> Result<(), String> {
    let _ = resource_dir;
    Err(crate::executor_companion::runtime::availability::UNSUPPORTED_PLATFORM_REASON.to_owned())
}

#[cfg(debug_assertions)]
pub(super) fn require_release_signature(
    _app: &AppHandle,
    _resource_dir: &Path,
    _packaged: &[String],
) -> Result<(), String> {
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
