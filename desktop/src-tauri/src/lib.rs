#[cfg(any(target_os = "linux", test))]
use std::ffi::OsStr;
use std::io::{Error, ErrorKind};
use tauri::utils::config::{WebviewUrl, WindowConfig};
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::Manager;
use tauri::WebviewWindowBuilder;
#[cfg(target_os = "linux")]
use tauri_plugin_deep_link::DeepLinkExt;

mod executor_companion;

const DESKTOP_INIT_SCRIPT: &str = concat!(
    include_str!("desktop_notifications_init.js"),
    // Both files end in an IIFE. A semicolon prevents the second one from
    // being parsed as a call on the first one's undefined return value.
    "\n;\n",
    include_str!("desktop_build_freshness_init.js")
);
#[cfg(test)]
const DEFAULT_DESKTOP_CAPABILITIES: &str = include_str!("../capabilities/default.json");
#[cfg(test)]
const DEVELOPMENT_DESKTOP_CAPABILITIES: &str = include_str!("../capabilities/development.json");
const PRODUCTION_ADMIN_URL: &str = "https://app.nessie.works/";
const DESKTOP_PLATFORM: &str = if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "unknown"
};

#[cfg(any(target_os = "linux", test))]
fn should_register_linux_deep_links(
    target_os: &str,
    appimage: Option<&OsStr>,
    debug_build: bool,
) -> bool {
    target_os == "linux" && (debug_build || appimage.is_some())
}

fn configure_desktop_window_frame(window_config: &mut WindowConfig, target_os: &str) {
    // macOS provides its own traffic lights. Windows and Linux get the
    // matching controls in the app chrome, so remove their native title-bar
    // buttons instead of showing two competing control sets.
    if matches!(target_os, "linux" | "windows") {
        window_config.decorations = false;
    }
    // Linux window managers do not round an undecorated GTK window for us.
    // Make only that native surface transparent; the shared frame paints and
    // clips the normal-window silhouette, while maximised and full-screen
    // states deliberately render flush.
    if target_os == "linux" {
        window_config.transparent = true;
        window_config.background_color = None;
    }
}

// An embedded Tauri bundle is served from tauri://localhost. Its requests to
// api.nessie.works are third-party in macOS WebKit, which blocks the HttpOnly
// refresh cookie that keeps a short-lived access JWT renewable. A normal
// release therefore loads the hosted admin as its top-level, same-site document.
fn desktop_webview_url(configured: WebviewUrl, release: bool) -> WebviewUrl {
    // A normal release points at the hosted same-site admin so its HttpOnly
    // session cookie remains renewable in the desktop WebView. The explicit
    // frontendDist override used for a local package becomes an App URL,
    // though, and must stay embedded or a freshly built UI can never run.
    if !release || matches!(configured, WebviewUrl::App(_)) {
        return configured;
    }

    WebviewUrl::External(
        PRODUCTION_ADMIN_URL
            .parse()
            .expect("the hard-coded production admin URL must be valid"),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(executor_companion::ExecutorCompanionState::default())
        .invoke_handler(tauri::generate_handler![
            executor_companion::executor_companion_configure_workspace,
            executor_companion::executor_companion_pair,
            executor_companion::executor_companion_start,
            executor_companion::executor_companion_status,
            executor_companion::executor_companion_stop,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if should_register_linux_deep_links(
                std::env::consts::OS,
                std::env::var_os("APPIMAGE").as_deref(),
                cfg!(debug_assertions),
            ) {
                app.deep_link()
                    .register_all()
                    .map_err(|error| Error::new(ErrorKind::Other, error))?;
            }

            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| Error::new(ErrorKind::NotFound, "missing main window config"))?;

            let mut window_config = main_window.clone();
            window_config.url = desktop_webview_url(window_config.url, !cfg!(debug_assertions));
            configure_desktop_window_frame(&mut window_config, DESKTOP_PLATFORM);

            WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(format!(
                    "{DESKTOP_INIT_SCRIPT}\n;window.__nessieDesktopPlatform = {DESKTOP_PLATFORM:?};"
                ))
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Nessie Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                executor_companion::shutdown(
                    app.state::<executor_companion::ExecutorCompanionState>()
                        .inner(),
                );
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        configure_desktop_window_frame, desktop_webview_url, should_register_linux_deep_links,
        DEFAULT_DESKTOP_CAPABILITIES, DESKTOP_INIT_SCRIPT, DEVELOPMENT_DESKTOP_CAPABILITIES,
        PRODUCTION_ADMIN_URL,
    };
    use std::ffi::OsStr;
    use tauri::utils::config::{Color, WebviewUrl, WindowConfig};

    #[test]
    fn linux_custom_frame_owns_its_transparent_rounded_surface() {
        let background = Color(46, 17, 50, 255);
        let mut linux = WindowConfig {
            background_color: Some(background),
            ..WindowConfig::default()
        };
        configure_desktop_window_frame(&mut linux, "linux");
        assert!(!linux.decorations);
        assert!(linux.transparent);
        assert_eq!(linux.background_color, None);

        let mut windows = WindowConfig {
            background_color: Some(background),
            ..WindowConfig::default()
        };
        configure_desktop_window_frame(&mut windows, "windows");
        assert!(!windows.decorations);
        assert!(!windows.transparent);
        assert_eq!(windows.background_color, Some(background));
    }

    #[test]
    fn release_window_uses_the_hosted_same_site_admin() {
        let configured = WebviewUrl::External(PRODUCTION_ADMIN_URL.parse().unwrap());
        let url = desktop_webview_url(configured, true);
        assert_eq!(url.to_string(), PRODUCTION_ADMIN_URL);
    }

    #[test]
    fn release_window_keeps_an_explicitly_embedded_admin() {
        let configured = WebviewUrl::App("index.html".into());
        assert_eq!(desktop_webview_url(configured.clone(), true), configured);
    }

    #[test]
    fn desktop_init_scripts_are_statement_separated() {
        assert!(DESKTOP_INIT_SCRIPT.contains("\n;\n"));
    }

    #[test]
    fn custom_window_controls_have_the_native_actions_they_need() {
        let actions = [
            "core:window:allow-close",
            "core:window:allow-minimize",
            "core:window:allow-is-maximized",
            "core:window:allow-maximize",
            "core:window:allow-unmaximize",
            "core:window:allow-current-monitor",
            "core:window:allow-set-position",
            "core:window:allow-set-size",
            "core:window:allow-is-fullscreen",
            "core:window:allow-set-fullscreen",
        ];
        for capabilities in [
            DEFAULT_DESKTOP_CAPABILITIES,
            DEVELOPMENT_DESKTOP_CAPABILITIES,
        ] {
            for action in actions {
                assert!(
                    capabilities.contains(action),
                    "missing native window permission: {action}"
                );
            }
        }
    }

    #[test]
    fn second_launches_forward_deep_links_to_the_running_app() {
        let cargo_manifest = include_str!("../Cargo.toml");
        assert!(cargo_manifest.contains(
            "tauri-plugin-single-instance = { version = \"2.4.2\", features = [\"deep-link\"] }"
        ));
    }

    #[test]
    fn linux_registers_runtime_handlers_only_when_the_package_does_not_own_one() {
        assert!(should_register_linux_deep_links("linux", None, true));
        assert!(should_register_linux_deep_links(
            "linux",
            Some(OsStr::new("/tmp/Nessie.AppImage")),
            false,
        ));
        assert!(!should_register_linux_deep_links("linux", None, false));
        assert!(!should_register_linux_deep_links(
            "windows",
            Some(OsStr::new("Nessie.exe")),
            true,
        ));
    }

    #[test]
    fn debug_window_preserves_its_configured_local_url() {
        let configured = WebviewUrl::External("http://localhost:5455/".parse().unwrap());
        assert_eq!(desktop_webview_url(configured.clone(), false), configured,);
    }

    #[test]
    fn this_build_uses_the_same_origin_selection_as_app_startup() {
        let configured = WebviewUrl::App("index.html".into());
        let selected = desktop_webview_url(configured.clone(), !cfg!(debug_assertions));
        assert_eq!(selected, configured);
    }
}
