use std::ffi::OsStr;

use tauri::WebviewWindow;

/// The desktop frame the admin paints is decided by the shell, never by a user
/// agent string, so the platform is published before any other init script runs.
const DESKTOP_INIT_SCRIPT: &str = concat!(
    include_str!("desktop_notifications_init.js"),
    "\n",
    include_str!("desktop_build_freshness_init.js")
);

/// Windows has no dock badge; its taskbar button carries a small overlay icon.
#[cfg(windows)]
const BADGE_OVERLAY_ICON: &[u8] = include_bytes!("../icons/badge-dot.png");

pub const SUPPORTED_PLATFORMS: [&str; 3] = ["macos", "windows", "linux"];

/// The exact literal the admin's `desktopPlatform` reads. A target the shared
/// shell contract does not describe has no frame to render, so it is a startup
/// failure rather than a silent default.
pub fn desktop_platform_literal(operating_system: &str) -> Option<&'static str> {
    SUPPORTED_PLATFORMS
        .into_iter()
        .find(|platform| *platform == operating_system)
}

pub fn desktop_platform() -> &'static str {
    desktop_platform_literal(std::env::consts::OS).unwrap_or_else(|| {
        panic!(
            "Nessie Desktop supports only macos, windows and linux; this build targets {}",
            std::env::consts::OS
        )
    })
}

/// The platform literal is injected as JSON so the value can never terminate the
/// assignment it sits in, whatever a future platform name looks like.
pub fn desktop_init_script(platform: &str) -> String {
    let literal = serde_json::to_string(platform)
        .expect("a platform literal must serialize as a JSON string");
    format!("window.__nessieDesktopPlatform = {literal};\n{DESKTOP_INIT_SCRIPT}")
}

/// An AppImage registers `nessie://` against the absolute path it was launched
/// from, so registration happens at every launch and only there: a `.deb`
/// install is registered by its own desktop entry, and re-registering would
/// point the scheme at a file the package manager owns.
pub fn should_register_deep_link_schemes(
    operating_system: &str,
    appimage_path: Option<&OsStr>,
) -> bool {
    operating_system == "linux" && appimage_path.is_some_and(|value| !value.is_empty())
}

/// Best-effort by construction: nothing in the admin depends on the badge, so a
/// platform that cannot show one answers `false` instead of failing the call.
#[tauri::command]
pub fn desktop_set_badge(window: WebviewWindow, count: Option<i64>) -> bool {
    let count = count.filter(|value| *value > 0);
    #[cfg(windows)]
    {
        let icon = match count {
            Some(_) => match tauri::image::Image::from_bytes(BADGE_OVERLAY_ICON) {
                Ok(image) => Some(image),
                Err(_) => return false,
            },
            None => None,
        };
        window.set_overlay_icon(icon).is_ok()
    }
    #[cfg(not(windows))]
    {
        window.set_badge_count(count).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_init_script, desktop_platform, desktop_platform_literal,
        should_register_deep_link_schemes, SUPPORTED_PLATFORMS,
    };
    use std::ffi::OsStr;

    #[test]
    fn maps_every_supported_target_to_its_admin_literal() {
        assert_eq!(desktop_platform_literal("macos"), Some("macos"));
        assert_eq!(desktop_platform_literal("windows"), Some("windows"));
        assert_eq!(desktop_platform_literal("linux"), Some("linux"));
    }

    #[test]
    fn refuses_a_platform_the_shell_contract_does_not_describe() {
        assert_eq!(desktop_platform_literal("freebsd"), None);
        assert_eq!(desktop_platform_literal("MacOS"), None);
        assert_eq!(desktop_platform_literal(""), None);
    }

    #[test]
    fn this_build_resolves_one_of_the_three_desktop_platforms() {
        assert!(SUPPORTED_PLATFORMS.contains(&desktop_platform()));
    }

    #[test]
    fn publishes_the_platform_before_the_existing_init_scripts_run() {
        let script = desktop_init_script("linux");
        let published = script
            .find("window.__nessieDesktopPlatform = \"linux\";")
            .expect("the platform must be published");
        let notifications = script
            .find("__nessieDesktopRequestNotificationPermission")
            .expect("the notification bridge must still be included");
        assert!(published < notifications);
        assert!(script.contains("__nessieBuildFreshnessInstalled"));
    }

    // Tauri merges a platform config over the base one with RFC 7396 JSON Merge
    // Patch, and a patched array replaces the whole target array rather than
    // merging into it. Each platform file therefore restates the entire main
    // window, and this test is what keeps the shared half of that statement from
    // drifting apart while only the chrome differs.
    #[test]
    fn every_platform_window_shares_one_size_and_background() {
        let shared = [
            "create",
            "label",
            "title",
            "width",
            "height",
            "minWidth",
            "minHeight",
            "resizable",
            "fullscreen",
            "theme",
            "backgroundColor",
        ];
        let base = main_window(include_str!("../tauri.conf.json"));
        for (platform, source) in [
            ("macos", include_str!("../tauri.macos.conf.json")),
            ("windows", include_str!("../tauri.windows.conf.json")),
            ("linux", include_str!("../tauri.linux.conf.json")),
        ] {
            let window = main_window(source);
            for key in shared {
                assert_eq!(window.get(key), base.get(key), "{platform} window {key}");
            }
        }
    }

    #[test]
    fn each_platform_states_the_chrome_the_shell_contract_gives_it() {
        let macos = main_window(include_str!("../tauri.macos.conf.json"));
        assert_eq!(macos["decorations"], serde_json::json!(true));
        assert_eq!(macos["titleBarStyle"], serde_json::json!("Overlay"));
        assert_eq!(macos["hiddenTitle"], serde_json::json!(true));

        let windows = main_window(include_str!("../tauri.windows.conf.json"));
        assert_eq!(windows["decorations"], serde_json::json!(false));
        assert_eq!(windows["shadow"], serde_json::json!(true));
        assert_eq!(windows.get("transparent"), None);

        let linux = main_window(include_str!("../tauri.linux.conf.json"));
        assert_eq!(linux["decorations"], serde_json::json!(false));
        assert_eq!(linux["transparent"], serde_json::json!(true));

        // macOS-only fields must not reach a platform that ignores them.
        for source in [
            include_str!("../tauri.conf.json"),
            include_str!("../tauri.windows.conf.json"),
            include_str!("../tauri.linux.conf.json"),
        ] {
            let window = main_window(source);
            assert_eq!(window.get("titleBarStyle"), None);
            assert_eq!(window.get("hiddenTitle"), None);
        }
    }

    fn main_window(source: &str) -> serde_json::Map<String, serde_json::Value> {
        let config: serde_json::Value =
            serde_json::from_str(source).expect("a Tauri config must be valid JSON");
        config["app"]["windows"]
            .as_array()
            .expect("a config under test must declare its windows")
            .iter()
            .find(|window| window["label"] == serde_json::json!("main"))
            .and_then(serde_json::Value::as_object)
            .cloned()
            .expect("every config must declare the main window")
    }

    #[test]
    fn registers_the_scheme_only_for_a_linux_appimage() {
        assert!(should_register_deep_link_schemes(
            "linux",
            Some(OsStr::new("/home/person/Downloads/Nessie.AppImage")),
        ));
        assert!(!should_register_deep_link_schemes("linux", None));
        assert!(!should_register_deep_link_schemes("linux", Some(OsStr::new(""))));
        assert!(!should_register_deep_link_schemes(
            "macos",
            Some(OsStr::new("/Applications/Nessie.AppImage")),
        ));
    }
}
