//! Release provenance on Windows: is this executable a release from the
//! publisher we pinned?
//!
//! Three Nessie binaries have to answer that question with the same words and
//! the same verdict — the desktop shell, the executor service, and the executor
//! tray — so the answer lives here rather than three times over. A packaged
//! runtime's hash manifest is a *self*-attestation: whoever can rewrite the
//! binary can rewrite the manifest, so the trust root has to be something the
//! operating system holds. On Windows that is Authenticode plus the publisher's
//! Azure Artifact Signing certificate-profile EKU, compiled into the release.
//!
//! The pin is that EKU and never a certificate thumbprint. Artifact Signing
//! renews its certificates daily and each one is valid for 72 hours, so a
//! thumbprint compiled into Monday's build refuses Tuesday's signature, and a
//! desktop and a service built on different days refuse each other. Every
//! certificate issued from one certificate profile carries the same
//! profile-specific EKU for the whole life of that profile, which is the durable
//! identity Microsoft documents for exactly this kind of pinning.
//!
//! The decision is a pure function of the pinned EKU and what verification
//! found, so it is tested on any host; the Win32 half that gathers those facts
//! is behind `cfg(windows)` and gathers nothing else.

#[cfg(windows)]
mod verify;

#[cfg(windows)]
pub use verify::collect_signature_facts;

pub const UNPINNED_REASON: &str =
    "Executor controls require a release build with a pinned Windows publisher.";

pub const UNSIGNED_REASON: &str =
    "Executor controls require a signed, intact Nessie release.";

pub const WRONG_PUBLISHER_REASON: &str =
    "Executor controls require the pinned Windows publisher signature.";

pub const UNVERIFIABLE_REASON: &str = "Nessie could not verify its release signature.";

/// The arc every Artifact Signing EKU sits under.
const ARTIFACT_SIGNING_EKU_ARC: &str = "1.3.6.1.4.1.311.97.";

/// What the Win32 verification saw. `trusted` is `WinVerifyTrust`'s verdict;
/// `signer_usages` are the enhanced key usages (dotted OIDs) of the leaf
/// certificate, read only from a chain that verification already trusted.
pub struct WindowsSignatureFacts {
    pub signer_usages: Option<Vec<String>>,
    pub trusted: bool,
}

/// The pinned value, when it names one certificate profile. Arc `1` directly
/// under the Artifact Signing arc is the service's own type arc: `…97.1.0` is
/// carried by *every* Public Trust certificate, and `…97.1.3.1.` and
/// `…97.1.4.1.` are Private Trust. Pinning anything beneath it would admit every
/// other subscriber's releases, so it is no pin at all.
fn pinned_profile(pinned: Option<&str>) -> Option<&str> {
    let pinned = pinned?.trim();
    let arcs: Vec<&str> = pinned.strip_prefix(ARTIFACT_SIGNING_EKU_ARC)?.split('.').collect();
    let numeric = arcs
        .iter()
        .all(|arc| !arc.is_empty() && arc.bytes().all(|byte| byte.is_ascii_digit()));
    (numeric && arcs.len() >= 2 && arcs[0] != "1").then_some(pinned)
}

/// The whole Windows decision, as a pure function of the pinned profile EKU and
/// what verification found. `facts` is `None` when the check could not run at
/// all, which is never treated as a pass.
pub fn decide_release_signature(
    pinned: Option<&str>,
    facts: Option<WindowsSignatureFacts>,
) -> Result<(), String> {
    let expected = pinned_profile(pinned).ok_or_else(|| UNPINNED_REASON.to_owned())?;
    let facts = facts.ok_or_else(|| UNVERIFIABLE_REASON.to_owned())?;
    if !facts.trusted {
        return Err(UNSIGNED_REASON.to_owned());
    }
    match facts.signer_usages {
        // An OID is compared whole. It has no case to fold, and a prefix match
        // would let a profile whose arcs merely begin with ours through.
        Some(usages) if usages.iter().any(|usage| usage.trim() == expected) => Ok(()),
        _ => Err(WRONG_PUBLISHER_REASON.to_owned()),
    }
}

/// The release check for the executable making the call. A build with no pinned
/// publisher — every development build — never gets executor controls.
#[cfg(windows)]
pub fn require_release_signature(pinned: Option<&str>) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|_| UNVERIFIABLE_REASON.to_owned())?;
    decide_release_signature(pinned, collect_signature_facts(&executable))
}

#[cfg(test)]
mod tests {
    use super::{
        decide_release_signature, WindowsSignatureFacts, UNPINNED_REASON, UNSIGNED_REASON,
        UNVERIFIABLE_REASON, WRONG_PUBLISHER_REASON,
    };

    /// Nessie's own certificate profile, `NessiePublicTrust`.
    const PINNED: &str = "1.3.6.1.4.1.311.97.178939473.798312218.613811551.894157712";
    /// Carried by every Artifact Signing Public Trust certificate, ours or not.
    const PUBLIC_TRUST: &str = "1.3.6.1.4.1.311.97.1.0";
    const CODE_SIGNING: &str = "1.3.6.1.5.5.7.3.3";

    fn signed_with(usages: &[&str]) -> Option<WindowsSignatureFacts> {
        Some(WindowsSignatureFacts {
            signer_usages: Some(usages.iter().map(|usage| (*usage).to_owned()).collect()),
            trusted: true,
        })
    }

    #[test]
    fn a_release_from_the_pinned_certificate_profile_passes() {
        assert!(
            decide_release_signature(Some(PINNED), signed_with(&[PUBLIC_TRUST, CODE_SIGNING, PINNED]))
                .is_ok()
        );
        // Spaces around a pasted value are not part of the identity.
        assert!(decide_release_signature(Some(&format!("  {PINNED}  ")), signed_with(&[PINNED])).is_ok());
    }

    #[test]
    fn a_build_with_no_pinned_profile_gets_no_executor_controls() {
        for pinned in [
            None,
            Some(""),
            Some("   "),
            // The marker every Public Trust certificate carries, and the two
            // Private Trust arcs: each would admit other subscribers' releases.
            Some(PUBLIC_TRUST),
            Some("1.3.6.1.4.1.311.97.1.3.1.29433.35007.34545.16815"),
            Some("1.3.6.1.4.1.311.97.1.4.1.29433.35007.34545.16815"),
            // Any code-signing certificate from anyone carries this one.
            Some(CODE_SIGNING),
            // Nothing, or not a dotted list of integers, after the arc.
            Some("1.3.6.1.4.1.311.97."),
            Some("1.3.6.1.4.1.311.97.178939473"),
            Some("1.3.6.1.4.1.311.97.178939473..894157712"),
            Some("1.3.6.1.4.1.311.97.abc.def"),
            // A leaf thumbprint, which a daily-renewed certificate outlives by a day.
            Some("a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d"),
        ] {
            assert_eq!(
                decide_release_signature(pinned, signed_with(&[PUBLIC_TRUST, CODE_SIGNING, PINNED])),
                Err(UNPINNED_REASON.to_owned()),
                "pinned {pinned:?} must not authorize executor controls",
            );
        }
    }

    /// The whole reason the signer certificate is read at all: `WinVerifyTrust`
    /// says "trusted", never "by whom", so a validly signed build from anyone
    /// else — another Artifact Signing subscriber included — is refused exactly
    /// like an unsigned one.
    #[test]
    fn a_valid_signature_from_another_profile_is_refused() {
        let other = "1.3.6.1.4.1.311.97.990309390.766961637.194916062.941502583";
        for usages in [
            vec![PUBLIC_TRUST, CODE_SIGNING, other],
            // The shared marker alone is somebody's Artifact Signing release.
            vec![PUBLIC_TRUST, CODE_SIGNING],
            // A profile whose arcs begin with ours is still another profile.
            vec![
                PUBLIC_TRUST,
                CODE_SIGNING,
                "1.3.6.1.4.1.311.97.178939473.798312218.613811551.8941577120",
            ],
        ] {
            assert_eq!(
                decide_release_signature(Some(PINNED), signed_with(&usages)),
                Err(WRONG_PUBLISHER_REASON.to_owned()),
                "{usages:?} must not pass as the pinned publisher",
            );
        }
        assert_eq!(
            decide_release_signature(
                Some(PINNED),
                Some(WindowsSignatureFacts { signer_usages: None, trusted: true }),
            ),
            Err(WRONG_PUBLISHER_REASON.to_owned()),
        );
    }

    #[test]
    fn an_untrusted_or_unverifiable_build_is_refused_and_never_reads_a_signer() {
        assert_eq!(
            decide_release_signature(
                Some(PINNED),
                // A tampered file can still carry the pinned EKU in its
                // certificate; only the trust verdict decides this.
                Some(WindowsSignatureFacts {
                    signer_usages: Some(vec![PINNED.to_owned()]),
                    trusted: false,
                }),
            ),
            Err(UNSIGNED_REASON.to_owned()),
        );
        assert_eq!(
            decide_release_signature(Some(PINNED), None),
            Err(UNVERIFIABLE_REASON.to_owned()),
        );
    }

    #[test]
    fn no_refusal_leaks_a_local_path() {
        for reason in [
            UNPINNED_REASON,
            UNSIGNED_REASON,
            WRONG_PUBLISHER_REASON,
            UNVERIFIABLE_REASON,
        ] {
            assert!(!reason.contains('/') && !reason.contains('\\'));
        }
    }
}
