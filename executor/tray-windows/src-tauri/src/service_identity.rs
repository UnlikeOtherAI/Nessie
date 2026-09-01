//! The names this tray uses that belong to it alone.
//!
//! The service name and its virtual account belong to the service as much as to
//! the tray, so they live in `nessie-windows-common` and are imported where they
//! are needed. What is left here is this application's own: where it looks,
//! and where its menu items go.

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
    use super::EXECUTORS_URL;

    /// Opened in the person's browser, so it is the admin origin rather than
    /// the API one, and it is fixed rather than assembled from anything a
    /// caller supplies.
    #[test]
    fn open_nessie_goes_to_the_executors_page_on_the_admin_origin() {
        assert_eq!(EXECUTORS_URL, "https://app.nessie.works/agents/executors");
    }
}
