//! The four names the tray shares with the service and its installer.
//!
//! Each is stated in more than one place by necessity — the service registers
//! itself, WiX authors the same strings into the MSI, and this application has
//! to find both — so each one carries a test that pins the relationships
//! between them. The virtual account in particular is *derived by Windows* from
//! the service name, so the two cannot be chosen independently.

/// The Windows service name. `nessie-executor-service` registers under it and
/// the MSI authors it; the tray reaches the service through its pipe and never
/// names it, so this exists to anchor the account below to the service it
/// belongs to, in the test at the bottom.
#[cfg(test)]
pub const SERVICE_NAME: &str = "NessieExecutor";

/// The account Windows creates for a service registered with that name and no
/// password. The workspace ACL grant names it.
pub const SERVICE_ACCOUNT: &str = r"NT SERVICE\NessieExecutor";

/// The service's own directory under `%ProgramData%`.
pub const SERVICE_DIRECTORY_NAME: &str = "Nessie Executor";

/// Where an elevated grant records the accounts the control pipe admits.
pub const CONTROL_CLIENTS_DIRECTORY: &str = "control-clients";

/// The folder **Open logs folder** opens.
pub const LOGS_DIRECTORY: &str = "logs";

/// Where **Open Nessie** goes: the page that mints an executor invitation and
/// confirms its fingerprint.
pub const EXECUTORS_URL: &str = "https://app.nessie.works/agents/executors";

#[cfg(test)]
mod tests {
    use super::{EXECUTORS_URL, SERVICE_ACCOUNT, SERVICE_NAME};

    /// Windows derives the virtual account from the service name; choosing them
    /// separately would produce an account that never exists.
    #[test]
    fn the_service_account_is_this_services_virtual_account() {
        assert_eq!(SERVICE_ACCOUNT, format!(r"NT SERVICE\{SERVICE_NAME}"));
        assert!(!SERVICE_NAME.contains(' '));
    }

    /// Opened in the person's browser, so it is the admin origin rather than
    /// the API one, and it is fixed rather than assembled from anything a
    /// caller supplies.
    #[test]
    fn open_nessie_goes_to_the_executors_page_on_the_admin_origin() {
        assert_eq!(EXECUTORS_URL, "https://app.nessie.works/agents/executors");
    }
}
