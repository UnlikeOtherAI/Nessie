//! Release provenance on Windows: is this executable a release from the
//! publisher we pinned?
//!
//! Three Nessie binaries have to answer that question with the same words and
//! the same verdict — the desktop shell, the executor service, and the executor
//! tray — so the answer lives here rather than three times over. A packaged
//! runtime's hash manifest is a *self*-attestation: whoever can rewrite the
//! binary can rewrite the manifest, so the trust root has to be something the
//! operating system holds. On Windows that is Authenticode plus the durable,
//! profile-specific Artifact Signing EKU compiled into the release.
//!
//! Artifact Signing renews its leaf certificate daily, so a certificate
//! thumbprint is deliberately not an identity. The decision is a pure function
//! of the pinned profile EKU and what verification found, so it is tested on
//! any host; the Win32 half that gathers those facts is behind `cfg(windows)`
//! and gathers nothing else.

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

/// What the Win32 verification saw. `trusted` is `WinVerifyTrust`'s verdict;
/// `signer_enhanced_key_usages` are the leaf certificate's EKUs, read only from
/// a chain that verification already trusted.
pub struct WindowsSignatureFacts {
    pub signer_enhanced_key_usages: Option<Vec<String>>,
    pub trusted: bool,
}

/// The whole Windows decision, as a pure function of the pinned profile EKU and
/// what verification found. `facts` is `None` when the check could not run at
/// all, which is never treated as a pass.
pub fn decide_release_signature(
    pinned: Option<&str>,
    facts: Option<WindowsSignatureFacts>,
) -> Result<(), String> {
    let expected = pinned
        .map(str::trim)
        .filter(|value| {
            value.starts_with("1.3.6.1.4.1.311.97.")
                && value.split('.').all(|arc| {
                    !arc.is_empty() && arc.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
        .ok_or_else(|| UNPINNED_REASON.to_owned())?;
    let facts = facts.ok_or_else(|| UNVERIFIABLE_REASON.to_owned())?;
    if !facts.trusted {
        return Err(UNSIGNED_REASON.to_owned());
    }
    match facts.signer_enhanced_key_usages {
        Some(actual) if actual.iter().any(|usage| usage == expected) => Ok(()),
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

    const PINNED: &str = "1.3.6.1.4.1.311.97.178939473.798312218.613811551.894157712";

    fn signed_by(eku: &str) -> Option<WindowsSignatureFacts> {
        Some(WindowsSignatureFacts {
            signer_enhanced_key_usages: Some(vec![
                "1.3.6.1.5.5.7.3.3".to_owned(),
                eku.to_owned(),
            ]),
            trusted: true,
        })
    }

    #[test]
    fn a_release_signed_by_the_pinned_publisher_passes() {
        assert!(decide_release_signature(Some(PINNED), signed_by(PINNED)).is_ok());
        // Configuration copied from a portal or shell may carry surrounding
        // whitespace; the OID itself remains an exact identity.
        assert!(
            decide_release_signature(Some(&format!("  {PINNED}  ")), signed_by(PINNED)).is_ok()
        );
    }

    #[test]
    fn a_build_with_no_pinned_publisher_gets_no_executor_controls() {
        for pinned in [
            None,
            Some(""),
            Some("   "),
            Some("1.3.6.1.5.5.7.3.3"),
            Some("1.3.6.1.4.1.311.97.not-an-oid"),
            Some("1.3.6.1.4.1.311.97."),
        ] {
            assert_eq!(
                decide_release_signature(pinned, signed_by(PINNED)),
                Err(UNPINNED_REASON.to_owned()),
                "pinned {pinned:?} must not authorize executor controls",
            );
        }
    }

    /// The whole reason the signer certificate is read at all: `WinVerifyTrust`
    /// says "trusted", never "by whom", so a validly signed build from anyone
    /// else must be refused exactly like an unsigned one.
    #[test]
    fn a_valid_signature_from_another_publisher_is_refused() {
        let other = "1.3.6.1.4.1.311.97.1.2.3.4";
        assert_eq!(
            decide_release_signature(Some(PINNED), signed_by(other)),
            Err(WRONG_PUBLISHER_REASON.to_owned()),
        );
        assert_eq!(
            decide_release_signature(
                Some(PINNED),
                Some(WindowsSignatureFacts {
                    signer_enhanced_key_usages: None,
                    trusted: true,
                }),
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
                    signer_enhanced_key_usages: Some(vec![PINNED.to_owned()]),
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
