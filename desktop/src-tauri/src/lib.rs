use std::io::{Error, ErrorKind};
use tauri::utils::config::WebviewUrl;
use tauri::Manager;
use tauri::WebviewWindowBuilder;

mod executor_companion;
mod shell;
#[cfg(feature = "direct-updater")]
mod direct_updater;

use shell::{desktop_init_script, desktop_platform, should_register_deep_link_schemes};

#[cfg(test)]
const DEFAULT_DESKTOP_CAPABILITIES: &str = include_str!("../capabilities/default.json");
#[cfg(test)]
const DEVELOPMENT_DESKTOP_CAPABILITIES: &str = include_str!("../capabilities/development.json");
#[cfg(test)]
const ADHOC_MACOS_CONFIG: &str = include_str!("../tauri.adhoc-macos.conf.json");
#[cfg(test)]
const DIRECT_UPDATER_CONFIG: &str = include_str!("../tauri.direct-updater.conf.json");
#[cfg(test)]
const APP_STORE_CONFIG: &str = include_str!("../tauri.appstore.conf.json");
#[cfg(test)]
const BASE_CONFIG: &str = include_str!("../tauri.conf.json");
#[cfg(test)]
const EXECUTOR_MENU_BAR_CONFIG: &str = include_str!("../tauri.executor-menubar.conf.json");
#[cfg(test)]
const DESKTOP_PACKAGE_MANIFEST: &str = include_str!("../../package.json");
const PRODUCTION_ADMIN_URL: &str = "https://app.nessie.works/";

// An embedded Tauri bundle is served from tauri://localhost. Its requests to
// api.nessie.works are third-party in macOS WebKit, which blocks the HttpOnly
// refresh cookie that keeps a short-lived access JWT renewable. A normal
// release therefore loads the hosted admin as its top-level, same-site document.
// The explicit embedded-build command is the one supported exception: its App
// URL contains a locally built admin bundle pinned to the production API.
fn desktop_webview_url(configured: WebviewUrl, release: bool) -> WebviewUrl {
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
    // Resolved before the first window exists: an unsupported target has no
    // frame the admin knows how to draw, so it must not reach a window at all.
    let platform = desktop_platform();
    let mut builder = tauri::Builder::default();

    // Direct installers carry the signed updater. App Store and development
    // builds deliberately leave it out, rather than merely hiding its UI.
    #[cfg(feature = "direct-updater")]
    {
        builder = direct_updater::configure(builder);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        // The single-instance plugin must be registered first, and its
        // deep-link feature is what carries a second launch's `nessie://`
        // callback into the running instance's onOpenUrl listeners.
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
            executor_companion::executor_companion_change_workspace,
            executor_companion::executor_companion_configure_workspace,
            executor_companion::executor_companion_forget,
            executor_companion::executor_companion_open_menu_bar_app,
            executor_companion::executor_companion_pair,
            executor_companion::executor_companion_start,
            executor_companion::executor_companion_status,
            executor_companion::executor_companion_stop,
            shell::desktop_set_badge,
            #[cfg(feature = "direct-updater")]
            direct_updater::desktop_direct_update_check,
            #[cfg(feature = "direct-updater")]
            direct_updater::desktop_direct_update_install,
            #[cfg(feature = "direct-updater")]
            direct_updater::desktop_direct_update_skip,
            #[cfg(feature = "direct-updater")]
            direct_updater::desktop_direct_update_remind,
        ])
        .setup(move |app| {
            if should_register_deep_link_schemes(
                std::env::consts::OS,
                std::env::var_os("APPIMAGE").as_deref(),
                cfg!(debug_assertions),
            ) {
                use tauri_plugin_deep_link::DeepLinkExt;
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

            WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(desktop_init_script(platform))
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
        desktop_webview_url, ADHOC_MACOS_CONFIG, APP_STORE_CONFIG, BASE_CONFIG,
        DEFAULT_DESKTOP_CAPABILITIES, DESKTOP_PACKAGE_MANIFEST, DEVELOPMENT_DESKTOP_CAPABILITIES,
        DIRECT_UPDATER_CONFIG, EXECUTOR_MENU_BAR_CONFIG, PRODUCTION_ADMIN_URL,
    };
    use tauri::utils::config::WebviewUrl;

    const EXECUTOR_MENU_BAR_CONFIG_FILE: &str = "src-tauri/tauri.executor-menubar.conf.json";

    /// The nested menu bar app is placed by `bundle.macOS.files`, whose keys Tauri
    /// resolves relative to the bundle's `Contents` directory — the same mechanism
    /// the App Store configuration already uses for its provisioning profile.
    /// `Library/LoginItems` is where macOS expects a menu bar helper and the only
    /// place `SMAppService.loginItem` can register one, so the path is the
    /// contract, not a convenience.
    #[test]
    fn the_nested_menu_bar_app_lands_where_macos_expects_a_login_item() {
        let config: serde_json::Value = serde_json::from_str(EXECUTOR_MENU_BAR_CONFIG).unwrap();
        let files = config["bundle"]["macOS"]["files"].as_object().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files["Library/LoginItems/Nessie Executor.app"],
            "./resources/executor-menubar/Nessie Executor.app",
        );
        assert_eq!(
            super::executor_companion::NESTED_MENU_BAR_APP_PATH,
            "Library/LoginItems/Nessie Executor.app",
            "the path Desktop opens must be the path the bundler wrote",
        );
    }

    /// The sandboxed App Store build deliberately carries no executor. It keeps
    /// `resources: []`, and — because it never passes the nesting configuration —
    /// there is no merge that could hand it the menu bar app either. That is a
    /// structural exclusion rather than an override to get wrong: a `files` object
    /// merged over another `files` object would have kept the nested entry.
    #[test]
    fn the_app_store_build_carries_no_executor_at_all() {
        let store: serde_json::Value = serde_json::from_str(APP_STORE_CONFIG).unwrap();
        assert_eq!(store["bundle"]["resources"], serde_json::json!([]));
        let files = store["bundle"]["macOS"]["files"].as_object().unwrap();
        assert_eq!(files.len(), 1);
        assert!(files.contains_key("embedded.provisionprofile"));
        assert!(
            !files.keys().any(|path| path.contains("LoginItems")),
            "the sandboxed store build must not nest the executor menu bar app",
        );

        // The base configuration has no `files` of its own, so nothing is inherited
        // into the store build from it either.
        let base: serde_json::Value = serde_json::from_str(BASE_CONFIG).unwrap();
        assert!(base["bundle"]["macOS"].get("files").is_none());

        let manifest: serde_json::Value = serde_json::from_str(DESKTOP_PACKAGE_MANIFEST).unwrap();
        let scripts = &manifest["scripts"];
        let store_build = scripts["tauri:build:appstore"].as_str().unwrap();
        assert!(store_build.contains("tauri.appstore.conf.json"));
        assert!(
            !store_build.contains(EXECUTOR_MENU_BAR_CONFIG_FILE),
            "the store build must never be handed the nesting configuration",
        );
        assert!(!store_build.contains("prepare:executor-menubar"));

        // The Developer ID executor build is the one that nests it, and it stages
        // the bundle before Tauri seals the enclosing app around it.
        let executor_build = scripts["tauri:build:executor"].as_str().unwrap();
        assert!(executor_build.contains(EXECUTOR_MENU_BAR_CONFIG_FILE));
        let staged = executor_build.find("prepare:executor-menubar").unwrap();
        let bundled = executor_build.find("tauri build").unwrap();
        assert!(staged < bundled, "signing is inside-out: the nested app is staged first");
    }

    #[test]
    fn release_window_uses_the_hosted_same_site_admin() {
        let configured = WebviewUrl::External("https://ignored.example/".parse().unwrap());
        let url = desktop_webview_url(configured, true);
        assert_eq!(url.to_string(), PRODUCTION_ADMIN_URL);
    }

    #[test]
    fn release_window_keeps_an_explicitly_embedded_admin() {
        let configured = WebviewUrl::App("index.html".into());
        assert_eq!(desktop_webview_url(configured.clone(), true), configured);
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
    fn only_the_direct_configuration_enables_the_signed_updater() {
        let direct: serde_json::Value = serde_json::from_str(DIRECT_UPDATER_CONFIG).unwrap();
        assert_eq!(direct["bundle"]["createUpdaterArtifacts"], true);
        assert_eq!(
            direct["plugins"]["updater"]["endpoints"][0],
            "https://github.com/UnlikeOtherAI/Nessie/releases/latest/download/latest.json"
        );
        assert!(direct["plugins"]["updater"]["pubkey"]
            .as_str()
            .is_some_and(|key| !key.is_empty()));

        let store: serde_json::Value = serde_json::from_str(APP_STORE_CONFIG).unwrap();
        assert!(store.get("plugins").is_none());
    }

    #[test]
    fn adhoc_macos_configuration_explicitly_selects_codesign_dash() {
        let adhoc: serde_json::Value = serde_json::from_str(ADHOC_MACOS_CONFIG).unwrap();
        assert_eq!(adhoc["bundle"]["macOS"]["signingIdentity"], "-");
    }

    #[test]
    fn second_launches_forward_deep_links_to_the_running_app() {
        let cargo_manifest = include_str!("../Cargo.toml");
        assert!(cargo_manifest.contains(
            "tauri-plugin-single-instance = { version = \"2.4.4\", features = [\"deep-link\"] }"
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
