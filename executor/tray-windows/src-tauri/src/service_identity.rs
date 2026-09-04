//! The names this tray uses that belong to it alone.
//!
//! The service name, its virtual account, and the layout under `%ProgramData%`
//! belong to the service as much as to the tray, so they live in
//! `nessie-windows-common` and are imported where they are needed. What is left
//! here is this application's own: how it reaches that root, and where its menu
//! items go.

use std::path::PathBuf;

use nessie_windows_common::SERVICE_DIRECTORY_NAME;

/// Where **Open Nessie** goes: the page that mints an executor invitation and
/// confirms its fingerprint.
pub const EXECUTORS_URL: &str = "https://app.nessie.works/agents/executors";

/// The service's root under `%ProgramData%`. A host that does not report that
/// directory is not one the service lays its state down on, and guessing a
/// path there would record a grant somewhere the service never reads.
pub fn service_root() -> Result<PathBuf, String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "Windows reported no ProgramData directory.".to_owned())?;
    Ok(PathBuf::from(program_data).join(SERVICE_DIRECTORY_NAME))
}

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
