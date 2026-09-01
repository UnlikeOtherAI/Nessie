use serde::Serialize;

use super::integrity::RuntimeFailureKind;
use super::ExecutorCompanionStatus;

/// What this computer can do as an executor. Every state carries a reason that
/// names its remedy, so the Executors panel explains itself instead of
/// vanishing when the answer is "not here".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionAvailability {
    Available,
    WorkspaceOnly,
    UnsignedRelease,
    RuntimeMissing,
    UnsupportedPlatform,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorCompanionAvailability {
    pub availability: CompanionAvailability,
    pub reason: String,
    pub platform: &'static str,
    pub executors: Vec<ExecutorCompanionStatus>,
}

pub const AVAILABLE_REASON: &str =
    "This computer can pair as an executor and run sandboxed work locally.";
pub const WORKSPACE_ONLY_REASON: &str =
    "This computer can pair as an executor for file review and drafts. Sandboxed commands, \
     browsers and coding sessions need virtualization: add your user to the `kvm` group and sign \
     in again.";
pub const UNSUPPORTED_PLATFORM_REASON: &str =
    "Windows executor controls arrive with the signed Windows release.";

impl CompanionAvailability {
    /// Pairing, starting, stopping and reconfiguring all need a local runtime.
    /// A workspace-only computer still has one — it just has no virtualization.
    pub fn permits_local_control(self) -> bool {
        matches!(self, Self::Available | Self::WorkspaceOnly)
    }
}

/// The whole decision, as a pure function of the three facts behind it.
pub(crate) fn classify_availability(
    platform: &str,
    runtime: Option<(RuntimeFailureKind, &str)>,
    virtualization_available: bool,
) -> (CompanionAvailability, String) {
    if platform == "windows" {
        return (CompanionAvailability::UnsupportedPlatform, UNSUPPORTED_PLATFORM_REASON.to_owned());
    }
    match runtime {
        Some((RuntimeFailureKind::Missing, reason)) => {
            (CompanionAvailability::RuntimeMissing, reason.to_owned())
        }
        Some((RuntimeFailureKind::Unsigned, reason)) => {
            (CompanionAvailability::UnsignedRelease, reason.to_owned())
        }
        None if platform == "linux" && !virtualization_available => {
            (CompanionAvailability::WorkspaceOnly, WORKSPACE_ONLY_REASON.to_owned())
        }
        None => (CompanionAvailability::Available, AVAILABLE_REASON.to_owned()),
    }
}

/// Linux sandbox sessions are Firecracker micro-VMs, which need read/write
/// access to `/dev/kvm`; the macOS backend uses Virtualization.framework and
/// needs no device permission.
#[cfg(target_os = "linux")]
pub(crate) fn virtualization_available() -> bool {
    let device = c"/dev/kvm";
    unsafe { libc::access(device.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn virtualization_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{
        classify_availability, CompanionAvailability, RuntimeFailureKind, AVAILABLE_REASON,
        UNSUPPORTED_PLATFORM_REASON, WORKSPACE_ONLY_REASON,
    };

    #[test]
    fn windows_is_refused_before_any_local_check() {
        let (availability, reason) = classify_availability(
            "windows",
            Some((RuntimeFailureKind::Missing, "packaged runtime is unavailable")),
            true,
        );
        assert_eq!(availability, CompanionAvailability::UnsupportedPlatform);
        assert_eq!(reason, UNSUPPORTED_PLATFORM_REASON);
        assert!(!availability.permits_local_control());
    }

    #[test]
    fn a_runtime_failure_keeps_its_own_reason() {
        let (availability, reason) =
            classify_availability("macos", Some((RuntimeFailureKind::Missing, "no runtime")), true);
        assert_eq!(availability, CompanionAvailability::RuntimeMissing);
        assert_eq!(reason, "no runtime");
        assert!(!availability.permits_local_control());

        let (availability, reason) = classify_availability(
            "linux",
            Some((RuntimeFailureKind::Unsigned, "install from the package")),
            true,
        );
        assert_eq!(availability, CompanionAvailability::UnsignedRelease);
        assert_eq!(reason, "install from the package");
        assert!(!availability.permits_local_control());
    }

    #[test]
    fn linux_without_kvm_pairs_as_workspace_only_and_names_the_remedy() {
        let (availability, reason) = classify_availability("linux", None, false);
        assert_eq!(availability, CompanionAvailability::WorkspaceOnly);
        assert_eq!(reason, WORKSPACE_ONLY_REASON);
        assert!(reason.contains("`kvm` group"));
        assert!(availability.permits_local_control());
    }

    #[test]
    fn a_verified_runtime_with_virtualization_is_available() {
        for platform in ["macos", "linux"] {
            let (availability, reason) = classify_availability(platform, None, true);
            assert_eq!(availability, CompanionAvailability::Available);
            assert_eq!(reason, AVAILABLE_REASON);
            assert!(availability.permits_local_control());
        }
    }

    #[test]
    fn macos_never_degrades_to_workspace_only_for_a_missing_kvm_device() {
        let (availability, _) = classify_availability("macos", None, false);
        assert_eq!(availability, CompanionAvailability::Available);
    }

    #[test]
    fn no_reason_leaks_a_local_path_or_process_output() {
        for reason in [AVAILABLE_REASON, WORKSPACE_ONLY_REASON, UNSUPPORTED_PLATFORM_REASON] {
            assert!(!reason.contains('/'));
            assert!(!reason.contains('\\'));
        }
    }
}
