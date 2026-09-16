//! The Nessie Executor menu bar app, from Nessie Desktop's side.
//!
//! Two copies of that app can exist on one Mac: the helper this Desktop ships at
//! `Contents/Library/LoginItems/Nessie Executor.app`, and a standalone install a
//! person dragged out of the DMG. Desktop's job here is small and deliberately
//! so — open the right one, and get out of the way when it is the one supervising
//! the daemon. Desktop is not a second supervisor: the daemon lease already
//! stops two daemons from running, and this module is about the interface telling
//! the truth instead of offering an action that would lose that race.
//!
//! Nothing here is launched by bundle identifier. Launch Services answers "who
//! claims this identifier", which is a different question from "is this our app":
//! a copy this Desktop did not ship has its signature and its Developer ID team
//! verified before it is opened, exactly as `integrity/provenance.rs` verifies
//! this Desktop's own bundle.

use std::path::{Path, PathBuf};

use super::{daemon_is_live, lease_blocks_start, read_daemon_lease};

/// Where Desktop nests the helper, relative to its own `Contents` directory.
/// `tauri.executor-menubar.conf.json` copies it to exactly this path, and
/// `Library/LoginItems` is both what macOS intends for a menu bar helper and the
/// only location `SMAppService.loginItem` can register.
pub(crate) const NESTED_MENU_BAR_APP_PATH: &str = "Library/LoginItems/Nessie Executor.app";

/// The app's own name, which is also how it appears in an Applications folder.
pub(crate) const MENU_BAR_APP_NAME: &str = "Nessie Executor.app";

/// Where the menu bar app keeps its executor state. It is its own pairing, not
/// Desktop's, and the daemon lease inside it is what says whether that app is
/// supervising this Mac right now. The two components are the ones
/// `ExecutorPaths.stateDirectory` in
/// `executor/menubar-macos/Sources/App/ExecutorController.swift` appends — named
/// after the product, never derived from a bundle identifier.
const MENU_BAR_STATE_COMPONENTS: [&str; 2] = ["Nessie Executor", "executor"];

/// What a person sees instead of a start button while the menu bar app has the
/// daemon. It names where the controls are, because "unavailable" with no
/// remedy is the thing this replaces.
pub const MENU_BAR_SUPERVISING_REASON: &str =
    "The Nessie Executor menu bar app is running this Mac's executor. Start and stop it from its \
     menu bar icon — Nessie Desktop will not start a second daemon beside it.";

/// Which copy of the menu bar app Desktop opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MenuBarApp {
    /// A standalone install. Desktop did not ship this bundle, so its signature
    /// and pinned team are verified before it is opened.
    Installed(PathBuf),
    /// The copy sealed inside this Desktop bundle. Its signature is part of this
    /// application's own, which `require_release_signature` already verified with
    /// `codesign --verify --deep --strict` before any executor control appeared.
    Nested(PathBuf),
}

impl MenuBarApp {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Installed(path) | Self::Nested(path) => path,
        }
    }
}

/// A standalone install wins over the nested copy.
///
/// Not a coin toss: a copy in an Applications folder is the one the person chose,
/// it has a stable path that survives a Desktop upgrade — which is what
/// launch-at-login registration needs — and it keeps supervising the daemon after
/// Desktop quits. The nested copy exists so that a Mac with Desktop needs no
/// second download at all, not to take precedence over a real install.
pub(crate) fn select_menu_bar_app(
    installed: &[PathBuf],
    nested: Option<PathBuf>,
) -> Option<MenuBarApp> {
    if let Some(path) = installed.first() {
        return Some(MenuBarApp::Installed(path.clone()));
    }
    nested.map(MenuBarApp::Nested)
}

/// The Applications folders, and only those.
///
/// A locator that indexed the whole disk would happily offer a copy on a mounted
/// disk image, in Downloads, or in the Trash. "Installed" means an Applications
/// folder, so that is what is looked in; anything else falls through to the
/// nested copy, which is the same product.
pub(crate) fn standalone_candidates(home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications").join(MENU_BAR_APP_NAME)];
    if let Some(home) = home {
        candidates.push(home.join("Applications").join(MENU_BAR_APP_NAME));
    }
    candidates.retain(|candidate| exists(candidate));
    candidates
}

/// The nested helper, resolved from this process's own executable rather than
/// from a resource directory: `<Nessie.app>/Contents/MacOS/Nessie` is the one
/// path that is true for every macOS bundle layout, and a development binary that
/// is not inside a `Contents` directory answers `None` instead of pointing
/// somewhere invented.
pub(crate) fn nested_menu_bar_app(executable: &Path) -> Option<PathBuf> {
    let contents = executable.parent()?.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    Some(contents.join(NESTED_MENU_BAR_APP_PATH))
}

pub(crate) fn menu_bar_state_dir(home: &Path) -> PathBuf {
    let mut path = home.join("Library").join("Application Support");
    for component in MENU_BAR_STATE_COMPONENTS {
        path = path.join(component);
    }
    path
}

/// Whether the status bar app is supervising a daemon on this Mac right now,
/// read from its own lease the same way Desktop reads its own: a lease naming a
/// live process, or one that cannot be read the way a daemon writes it.
pub(crate) fn menu_bar_daemon_live() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Some(home) = std::env::var_os("HOME") else { return false };
    let state_dir = menu_bar_state_dir(Path::new(&home));
    lease_blocks_start(&read_daemon_lease(&state_dir), daemon_is_live)
}

/// Whether Desktop steps aside instead of offering its own daemon controls.
///
/// A daemon Desktop started itself is still Desktop's to stop — the person has to
/// be able to end what they began here. It is only the case where the menu bar
/// app holds the daemon and Desktop holds nothing that Desktop must defer rather
/// than offer a start that would lose the race for the lease.
pub(crate) fn defers_to_menu_bar_app(
    menu_bar_daemon_live: bool,
    desktop_owns_running_daemon: bool,
) -> bool {
    menu_bar_daemon_live && !desktop_owns_running_daemon
}

/// The signature check for a bundle this Desktop did not ship, and the reason it
/// exists: `/Applications/Nessie Executor.app` is a name, not an identity.
///
/// The same two facts `integrity/provenance.rs` requires of this Desktop's own
/// bundle — an intact signature, and the Developer ID team compiled into this
/// release — because a helper that supervises a local daemon is exactly as
/// sensitive as the app that would launch it.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
pub(crate) fn require_pinned_developer_id(path: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};

    const PRODUCTION_SIGNING_TEAM_ID: Option<&str> = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID");

    let expected_team = PRODUCTION_SIGNING_TEAM_ID
        .filter(|team| !team.is_empty() && team.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .ok_or_else(|| {
            "Opening the Nessie Executor app requires a release build with a pinned Developer ID team."
                .to_owned()
        })?;
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Nessie Desktop could not verify the installed Nessie Executor app.".to_owned())?
        .success();
    if !verified {
        return Err(UNVERIFIED_INSTALL_REASON.to_owned());
    }
    let metadata = Command::new("/usr/bin/codesign")
        .args(["-dvv"])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Nessie Desktop could not inspect the installed Nessie Executor app.".to_owned())?;
    let details = String::from_utf8_lossy(&metadata.stderr);
    if signature_details_match_pinned_team(&details, expected_team) {
        Ok(())
    } else {
        Err(UNVERIFIED_INSTALL_REASON.to_owned())
    }
}

/// A development build never launches an installed copy: the pin it would check
/// against is a release-only fact, so there is nothing to check it with. It opens
/// the nested copy or says it has none.
#[cfg(any(debug_assertions, not(target_os = "macos")))]
pub(crate) fn require_pinned_developer_id(_path: &Path) -> Result<(), String> {
    Err("A development Nessie Desktop build opens only the Nessie Executor app it ships.".to_owned())
}

#[cfg(any(test, all(not(debug_assertions), target_os = "macos")))]
pub(crate) const UNVERIFIED_INSTALL_REASON: &str =
    "The Nessie Executor app installed on this Mac is not the signed Nessie release. Nessie Desktop \
     will not open it. Reinstall it from the Nessie Executor download.";

/// The two lines that decide whether a signature is ours, split out so the
/// decision is testable without a signed bundle on disk. Whole-line comparisons:
/// `TeamIdentifier=ABCDE12345X` must not satisfy a pin on `ABCDE12345`.
#[cfg(any(test, all(not(debug_assertions), target_os = "macos")))]
pub(crate) fn signature_details_match_pinned_team(details: &str, expected_team: &str) -> bool {
    details.lines().any(|line| line.trim() == format!("TeamIdentifier={expected_team}"))
        && details
            .lines()
            .any(|line| line.trim_start().starts_with("Authority=Developer ID Application:"))
}

/// Opens a bundle by the path that was verified, never by a bundle identifier:
/// `open -b` would launch whatever claims the identifier at that moment, which is
/// not necessarily the bundle whose signature was just checked.
#[cfg(target_os = "macos")]
fn open_bundle(path: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let opened = Command::new("/usr/bin/open")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Nessie Desktop could not open the Nessie Executor app.".to_owned())?
        .success();
    if opened {
        Ok(())
    } else {
        Err("Nessie Desktop could not open the Nessie Executor app.".to_owned())
    }
}

#[cfg(not(target_os = "macos"))]
fn open_bundle(_path: &Path) -> Result<(), String> {
    Err(NO_MENU_BAR_APP_REASON.to_owned())
}

pub(crate) const NO_MENU_BAR_APP_REASON: &str =
    "The Nessie Executor menu bar app is a macOS app, and this Nessie Desktop build does not ship a \
     copy of it.";

/// Which copy this Desktop would open, with no side effects, so the Executors
/// panel can offer the control only when there is something behind it.
pub(crate) fn resolve_menu_bar_app() -> Option<MenuBarApp> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let installed = standalone_candidates(home.as_deref(), |path| path.is_dir());
    let nested = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(nested_menu_bar_app)
        .filter(|path| path.is_dir());
    select_menu_bar_app(&installed, nested)
}

/// Opens the status bar app and hands this Mac's executor over to it.
///
/// A standalone install is verified first and refused rather than opened if it is
/// not the signed Nessie release. The singleton rule in the app itself
/// (`Sources/Core/SingleInstance.swift`) is what stops a second status icon when
/// a copy is already running: whichever launches second activates the first and
/// exits.
pub(crate) fn open_menu_bar_app() -> Result<(), String> {
    let Some(app) = resolve_menu_bar_app() else { return Err(NO_MENU_BAR_APP_REASON.to_owned()) };
    if matches!(app, MenuBarApp::Installed(_)) {
        require_pinned_developer_id(app.path())?;
    }
    open_bundle(app.path())
}

#[cfg(test)]
mod tests {
    use super::{
        defers_to_menu_bar_app, menu_bar_state_dir, nested_menu_bar_app, select_menu_bar_app,
        signature_details_match_pinned_team, standalone_candidates, MenuBarApp,
        MENU_BAR_SUPERVISING_REASON, NESTED_MENU_BAR_APP_PATH, NO_MENU_BAR_APP_REASON,
        UNVERIFIED_INSTALL_REASON,
    };
    use std::path::{Path, PathBuf};

    const MENU_BAR_STATE_PATH_SOURCE: &str = include_str!(
        "../../../../../executor/menubar-macos/Sources/App/ExecutorController.swift"
    );

    /// The copy the person installed themselves wins, because its path survives a
    /// Desktop upgrade and it keeps running after Desktop quits.
    #[test]
    fn an_installed_copy_is_preferred_over_the_nested_one() {
        let installed = PathBuf::from("/Applications/Nessie Executor.app");
        let nested = PathBuf::from("/Applications/Nessie.app/Contents").join(NESTED_MENU_BAR_APP_PATH);
        assert_eq!(
            select_menu_bar_app(&[installed.clone()], Some(nested.clone())),
            Some(MenuBarApp::Installed(installed.clone())),
        );
        // Whichever order the candidates arrive in, the first existing install is
        // the one chosen — never a mix of both.
        assert_eq!(
            select_menu_bar_app(&[installed.clone()], None),
            Some(MenuBarApp::Installed(installed)),
        );
    }

    /// The point of nesting: a Mac with only Nessie Desktop still has the app.
    #[test]
    fn with_no_install_the_nested_copy_is_opened() {
        let nested = PathBuf::from("/Applications/Nessie.app/Contents").join(NESTED_MENU_BAR_APP_PATH);
        assert_eq!(
            select_menu_bar_app(&[], Some(nested.clone())),
            Some(MenuBarApp::Nested(nested)),
        );
        assert_eq!(select_menu_bar_app(&[], None), None);
    }

    /// An App Store build ships no nested copy and has no install to fall back
    /// on, so the control has nothing behind it and must not be offered.
    #[test]
    fn nothing_to_open_is_a_state_with_a_reason_not_a_silent_nothing() {
        assert_eq!(select_menu_bar_app(&[], None), None);
        assert!(NO_MENU_BAR_APP_REASON.contains("macOS"));
        assert!(!NO_MENU_BAR_APP_REASON.contains('/'));
    }

    /// Only Applications folders. A copy on a mounted disk image, in Downloads or
    /// in the Trash is not an install, and offering to launch one is how a person
    /// ends up running a bundle they thought they had thrown away.
    #[test]
    fn only_an_applications_folder_counts_as_installed() {
        let home = PathBuf::from("/Users/person");
        let found = standalone_candidates(Some(&home), |_| true);
        assert_eq!(
            found,
            vec![
                PathBuf::from("/Applications/Nessie Executor.app"),
                PathBuf::from("/Users/person/Applications/Nessie Executor.app"),
            ],
        );
        for refused in [
            "/Volumes/Nessie Executor/Nessie Executor.app",
            "/Users/person/Downloads/Nessie Executor.app",
            "/Users/person/.Trash/Nessie Executor.app",
            "/tmp/Nessie Executor.app",
        ] {
            assert!(
                !found.iter().any(|candidate| candidate == Path::new(refused)),
                "{refused} must never be treated as an install",
            );
        }
        assert!(standalone_candidates(Some(&home), |_| false).is_empty());
        // No home directory is not an error: the system folder is still looked in.
        assert_eq!(
            standalone_candidates(None, |_| true),
            vec![PathBuf::from("/Applications/Nessie Executor.app")],
        );
    }

    #[test]
    fn the_nested_copy_is_resolved_from_the_running_executable() {
        assert_eq!(
            nested_menu_bar_app(Path::new("/Applications/Nessie.app/Contents/MacOS/Nessie")),
            Some(
                PathBuf::from("/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app")
            ),
        );
        // A binary that is not inside a bundle answers nothing rather than
        // inventing a path beside itself.
        for outside in ["/usr/local/bin/nessie", "target/release/nessie", "nessie"] {
            assert_eq!(nested_menu_bar_app(Path::new(outside)), None, "{outside}");
        }
    }

    /// The path is the menu bar app's, so the two must agree. Its own comment
    /// says why it is named after the product rather than the bundle identifier:
    /// changing an identifier must not strand a person's pairing.
    #[test]
    fn the_menu_bar_state_directory_matches_the_app_that_writes_it() {
        assert_eq!(
            menu_bar_state_dir(Path::new("/Users/person")),
            PathBuf::from("/Users/person/Library/Application Support/Nessie Executor/executor"),
        );
        assert!(MENU_BAR_STATE_PATH_SOURCE.contains("appendingPathComponent(\"Nessie Executor\")"));
        assert!(MENU_BAR_STATE_PATH_SOURCE.contains("appendingPathComponent(\"executor\")"));
        assert!(MENU_BAR_STATE_PATH_SOURCE.contains("applicationSupportDirectory"));
    }

    /// Desktop defers to the menu bar app, but never to the point of refusing to
    /// stop a daemon it started itself.
    #[test]
    fn desktop_defers_only_when_the_menu_bar_app_holds_the_daemon() {
        assert!(defers_to_menu_bar_app(true, false));
        assert!(!defers_to_menu_bar_app(true, true));
        assert!(!defers_to_menu_bar_app(false, false));
        assert!(!defers_to_menu_bar_app(false, true));
    }

    #[test]
    fn the_deferral_names_where_the_controls_are() {
        assert!(MENU_BAR_SUPERVISING_REASON.contains("menu bar"));
        assert!(!MENU_BAR_SUPERVISING_REASON.contains('/'));
        assert!(!UNVERIFIED_INSTALL_REASON.contains('/'));
    }

    /// A bundle identifier is a claim; a signature is evidence. This is the
    /// decision that separates them, and a near miss on the team must not pass.
    #[test]
    fn a_pinned_team_is_matched_whole_never_as_a_prefix() {
        let ours = "Executable=/Applications/Nessie Executor.app/Contents/MacOS/Nessie Executor\n\
                    Authority=Developer ID Application: UnlikeOtherAI (ABCDE12345)\n\
                    TeamIdentifier=ABCDE12345\n";
        assert!(signature_details_match_pinned_team(ours, "ABCDE12345"));
        assert!(!signature_details_match_pinned_team(ours, "ABCDE1234"));
        assert!(!signature_details_match_pinned_team(ours, "BCDE12345"));

        // Somebody else's Developer ID, and an ad-hoc build, are both refused.
        let theirs = "Authority=Developer ID Application: Someone Else (ZZZZZ99999)\n\
                      TeamIdentifier=ZZZZZ99999\n";
        assert!(!signature_details_match_pinned_team(theirs, "ABCDE12345"));
        let adhoc = "Signature=adhoc\nTeamIdentifier=not set\n";
        assert!(!signature_details_match_pinned_team(adhoc, "ABCDE12345"));
        // The right team with no Developer ID authority is not a distribution
        // signature: a development certificate carries the same team.
        let development = "Authority=Apple Development: person@example.test (ABCDE12345)\n\
                           TeamIdentifier=ABCDE12345\n";
        assert!(!signature_details_match_pinned_team(development, "ABCDE12345"));
    }
}
