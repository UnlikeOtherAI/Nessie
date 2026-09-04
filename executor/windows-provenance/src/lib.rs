//! Release provenance on Windows: is this executable a release from the
//! publisher we pinned?
//!
//! Three Nessie binaries have to answer that question with the same words and
//! the same verdict — the desktop shell, the executor service, and the executor
//! tray — so the answer lives here rather than three times over. A packaged
//! runtime's hash manifest is a *self*-attestation: whoever can rewrite the
//! binary can rewrite the manifest, so the trust root has to be something the
//! operating system holds. On Windows that is Authenticode plus a publisher
//! thumbprint compiled into the release.
//!
//! The decision is a pure function of the pinned thumbprint and what
//! verification found, so it is tested on any host; the Win32 half that gathers
//! those facts is behind `cfg(windows)` and gathers nothing else.

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
/// `signer_thumbprint` is the leaf certificate's SHA-1 thumbprint, read only
/// from a chain that verification already trusted.
pub struct WindowsSignatureFacts {
    pub signer_thumbprint: Option<String>,
    pub trusted: bool,
}

/// The whole Windows decision, as a pure function of the pinned thumbprint and
/// what verification found. `facts` is `None` when the check could not run at
/// all, which is never treated as a pass.
pub fn decide_release_signature(
    pinned: Option<&str>,
    facts: Option<WindowsSignatureFacts>,
) -> Result<(), String> {
    let expected = pinned
        .map(str::trim)
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| UNPINNED_REASON.to_owned())?;
    let facts = facts.ok_or_else(|| UNVERIFIABLE_REASON.to_owned())?;
    if !facts.trusted {
        return Err(UNSIGNED_REASON.to_owned());
    }
    match facts.signer_thumbprint {
        // Hexadecimal case is a rendering choice, not part of the identity, so
        // a thumbprint pasted from `certutil` in upper case still matches.
        Some(actual) if actual.trim().eq_ignore_ascii_case(expected) => Ok(()),
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

    const PINNED: &str = "a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d";

    fn signed_by(thumbprint: &str) -> Option<WindowsSignatureFacts> {
        Some(WindowsSignatureFacts {
            signer_thumbprint: Some(thumbprint.to_owned()),
            trusted: true,
        })
    }

    #[test]
    fn a_release_signed_by_the_pinned_publisher_passes() {
        assert!(decide_release_signature(Some(PINNED), signed_by(PINNED)).is_ok());
        // Hexadecimal case is a rendering choice: `certutil` prints upper case.
        assert!(decide_release_signature(Some(PINNED), signed_by(&PINNED.to_uppercase())).is_ok());
        assert!(decide_release_signature(Some(&PINNED.to_uppercase()), signed_by(PINNED)).is_ok());
        // Windows hands thumbprints back with spaces around them often enough.
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
            // Too short, too long, and not hexadecimal: each would make the
            // comparison meaningless rather than merely wrong.
            Some("a1b2c3"),
            Some("a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d0"),
            Some("zzb2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d"),
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
        let other = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
        assert_eq!(
            decide_release_signature(Some(PINNED), signed_by(other)),
            Err(WRONG_PUBLISHER_REASON.to_owned()),
        );
        assert_eq!(
            decide_release_signature(
                Some(PINNED),
                Some(WindowsSignatureFacts { signer_thumbprint: None, trusted: true }),
            ),
            Err(WRONG_PUBLISHER_REASON.to_owned()),
        );
    }

    #[test]
    fn an_untrusted_or_unverifiable_build_is_refused_and_never_reads_a_signer() {
        assert_eq!(
            decide_release_signature(
                Some(PINNED),
                // A tampered file can still carry the pinned thumbprint in its
                // certificate; only the trust verdict decides this.
                Some(WindowsSignatureFacts {
                    signer_thumbprint: Some(PINNED.to_owned()),
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
