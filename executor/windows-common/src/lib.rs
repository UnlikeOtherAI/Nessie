//! What the Nessie Executor service and its tray both have to agree on.
//!
//! Two facts, and both are the kind that break silently when they are stated
//! twice: the account Windows derives from the service name — pick the two
//! separately and the grant names an account that never exists — and the string
//! form of a SID, which the tray writes as a file name and the service reads
//! back and hands to Win32.
//!
//! The names and the validation are portable, so they are tested on any host.
//! The one Win32 call lives behind `cfg(windows)` in [`sid`].

#[cfg(windows)]
mod sid;

#[cfg(windows)]
pub use sid::sid_to_string;

/// The Windows service name. `nessie-executor-service` registers under it and
/// the MSI authors the same string.
pub const SERVICE_NAME: &str = "NessieExecutor";

/// The account Windows creates for a service registered with that name and no
/// password. The workspace ACL grant and the Hyper-V group membership name it.
pub const SERVICE_ACCOUNT: &str = r"NT SERVICE\NessieExecutor";

/// A SID in its string form, checked before it is ever handed to Win32 or used
/// as a file name: `S-1-` followed by dash-separated decimal parts.
pub fn is_sid_string(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("S-1-") else {
        return false;
    };
    !rest.is_empty()
        && value.len() <= 187
        && rest.split('-').all(|part| {
            !part.is_empty() && part.len() <= 20 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::{is_sid_string, SERVICE_ACCOUNT, SERVICE_NAME};

    /// Windows derives the virtual account from the service name; choosing them
    /// separately would produce an account that never exists.
    #[test]
    fn the_service_account_is_this_services_virtual_account() {
        assert_eq!(SERVICE_ACCOUNT, format!(r"NT SERVICE\{SERVICE_NAME}"));
        assert!(!SERVICE_NAME.contains(' '));
    }

    #[test]
    fn only_a_well_formed_sid_string_is_accepted() {
        assert!(is_sid_string("S-1-5-21-1004336348-1177238915-682003330-1001"));
        assert!(is_sid_string("S-1-5-32-544"));
        for value in [
            "",
            "S-1-",
            "s-1-5-32-544",
            "S-1-5-32-",
            "S-1-5--544",
            "S-1-5-32-544; DROP",
            "Everyone",
            "..\\..\\windows",
        ] {
            assert!(!is_sid_string(value), "SID {value:?} must be refused");
        }
    }
}
