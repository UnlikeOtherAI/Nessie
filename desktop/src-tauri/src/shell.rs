use std::ffi::OsStr;

use tauri::utils::config::Color;
use tauri::{Theme, WebviewWindow};

/// The desktop frame the admin paints is decided by the shell, never by a user
/// agent string, so the platform is published before any other init script runs.
const DESKTOP_INIT_SCRIPT: &str = concat!(
    include_str!("desktop_notifications_init.js"),
    // Both files end in an IIFE. A semicolon prevents the second one from
    // being parsed as a call on the first one's undefined return value.
    "\n;\n",
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
    format!(
        "window.__nessieDesktopPlatform = {literal};\nwindow.__nessieDirectUpdater = {};\n{DESKTOP_INIT_SCRIPT}",
        cfg!(feature = "direct-updater"),
    )
}

/// An AppImage registers `nessie://` against the absolute path it was launched
/// from, so registration happens at every launch and only there: a `.deb`
/// install is registered by its own desktop entry, and re-registering would
/// point the scheme at a file the package manager owns.
pub fn should_register_deep_link_schemes(
    operating_system: &str,
    appimage_path: Option<&OsStr>,
    debug_build: bool,
) -> bool {
    operating_system == "linux"
        && (debug_build || appimage_path.is_some_and(|value| !value.is_empty()))
}

/// A CSS colour as a custom property hands it over: `#rgb`, `#rrggbb`, or the
/// `rgb()`/`rgba()` form a computed style falls back to. Anything else — a
/// colour function the page picked up from an organisation palette, an empty
/// string before the palette resolves — answers `None`, and the window keeps
/// the colour it had rather than flashing black.
pub fn parse_css_colour(value: &str) -> Option<Color> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let digits: Vec<u8> = hex
            .chars()
            .map(|character| character.to_digit(16).map(|digit| digit as u8))
            .collect::<Option<_>>()?;
        return match digits.len() {
            3 => Some(Color(
                digits[0] * 17,
                digits[1] * 17,
                digits[2] * 17,
                255,
            )),
            6 => Some(Color(
                digits[0] * 16 + digits[1],
                digits[2] * 16 + digits[3],
                digits[4] * 16 + digits[5],
                255,
            )),
            _ => None,
        };
    }

    let inner = value
        .strip_prefix("rgba(")
        .or_else(|| value.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let mut parts = inner.split([',', '/', ' ']).filter(|part| !part.trim().is_empty());
    let mut channel = || -> Option<f32> { parts.next()?.trim().parse::<f32>().ok() };
    let (red, green, blue) = (channel()?, channel()?, channel()?);
    // The alpha a translucent overlay would carry is dropped rather than
    // honoured: the window behind the webview has nothing to blend with.
    Some(Color(red as u8, green as u8, blue as u8, 255))
}

/// The page's `color-scheme`, as the native window understands it. An
/// unrecognised value leaves the window following the system, which is what it
/// did before the page had an opinion.
pub fn window_theme(scheme: &str) -> Option<Theme> {
    match scheme.trim() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

/// The page's chrome, handed to the native window. Two things the page cannot
/// paint for itself:
///
/// **The colour of an empty window.** Cmd/Ctrl+R throws the document away, and
/// until the next one paints there is nothing on screen but this colour — it
/// was a hard-coded `#2e1132`, the rail of the palette that was default before
/// the Nessie theme, so every reload flashed purple.
///
/// **The window's appearance.** AppKit draws its own titlebar furniture — the
/// traffic lights, and the screen-sharing control macOS inserts beside them
/// while a window is shared — in the window's `NSAppearance`, not in anything
/// the webview paints. Left following the system, that control rendered as a
/// white block on the dark bar. `set_theme` is app-wide on macOS and Linux,
/// which is what we want: a document window is the same chrome.
///
/// Best-effort like the badge: a platform that ignores either call is not a
/// reason to fail the page's render.
#[tauri::command]
pub fn desktop_set_chrome(window: WebviewWindow, background: String, scheme: String) -> bool {
    let painted = parse_css_colour(&background)
        .is_some_and(|colour| window.set_background_color(Some(colour)).is_ok());
    if let Some(theme) = window_theme(&scheme) {
        let _ = window.set_theme(Some(theme));
    }
    painted
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
        desktop_init_script, desktop_platform, desktop_platform_literal, parse_css_colour,
        should_register_deep_link_schemes, window_theme, Color, Theme, SUPPORTED_PLATFORMS,
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
        assert!(script.contains("\n;\n"));
        assert!(script.contains("__nessieBuildFreshnessInstalled"));
    }

    #[test]
    fn publishes_direct_update_availability_before_the_admin_loads() {
        let script = desktop_init_script("linux");
        assert!(script.contains(&format!(
            "window.__nessieDirectUpdater = {};",
            cfg!(feature = "direct-updater")
        )));
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
    fn reads_every_colour_shape_a_css_custom_property_arrives_in() {
        assert_eq!(parse_css_colour("#0b172a"), Some(Color(11, 23, 42, 255)));
        assert_eq!(parse_css_colour("  #FFF  "), Some(Color(255, 255, 255, 255)));
        assert_eq!(parse_css_colour("rgb(11, 23, 42)"), Some(Color(11, 23, 42, 255)));
        assert_eq!(parse_css_colour("rgb(11 23 42)"), Some(Color(11, 23, 42, 255)));
        // The window behind the webview has nothing to blend with, so alpha goes.
        assert_eq!(parse_css_colour("rgba(11, 23, 42, 0.5)"), Some(Color(11, 23, 42, 255)));
    }

    #[test]
    fn keeps_the_window_it_has_rather_than_guessing() {
        // A palette that has not resolved yet, and a colour space this shell
        // does not read, both leave the window alone — a black flash would be
        // worse than the colour already on it.
        assert_eq!(parse_css_colour(""), None);
        assert_eq!(parse_css_colour("#12345"), None);
        assert_eq!(parse_css_colour("#zzzzzz"), None);
        assert_eq!(parse_css_colour("oklch(0.7 0.1 250)"), None);
        assert_eq!(parse_css_colour("rgb(11, 23)"), None);
    }

    #[test]
    fn only_a_scheme_the_page_states_moves_the_window_off_the_system_one() {
        assert_eq!(window_theme("dark"), Some(Theme::Dark));
        assert_eq!(window_theme(" light "), Some(Theme::Light));
        assert_eq!(window_theme("normal"), None);
        assert_eq!(window_theme(""), None);
    }

    /// The configured colour is what an empty window shows before the page has
    /// published anything, so it has to be the default theme's chrome rather
    /// than a palette nobody is on any more. `#0b172a` is `--rail` under
    /// `[data-theme="nessie"]`'s chrome scope in admin/src/styles.css.
    #[test]
    fn every_window_starts_on_the_default_theme_chrome() {
        for source in [
            include_str!("../tauri.conf.json"),
            include_str!("../tauri.macos.conf.json"),
            include_str!("../tauri.windows.conf.json"),
            include_str!("../tauri.linux.conf.json"),
        ] {
            let window = main_window(source);
            assert_eq!(window["backgroundColor"], serde_json::json!("#0b172a"));
        }
    }

    #[test]
    fn registers_the_scheme_only_for_a_linux_appimage() {
        assert!(should_register_deep_link_schemes(
            "linux",
            Some(OsStr::new("/home/person/Downloads/Nessie.AppImage")),
            false,
        ));
        assert!(should_register_deep_link_schemes("linux", None, true));
        assert!(!should_register_deep_link_schemes("linux", None, false));
        assert!(!should_register_deep_link_schemes(
            "linux",
            Some(OsStr::new("")),
            false,
        ));
        assert!(!should_register_deep_link_schemes(
            "macos",
            Some(OsStr::new("/Applications/Nessie.AppImage")),
            true,
        ));
    }
}
