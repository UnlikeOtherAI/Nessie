use std::io::{Error, ErrorKind};
use tauri::utils::config::WebviewUrl;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::Manager;
use tauri::WebviewWindowBuilder;
#[cfg(target_os = "linux")]
use tauri_plugin_deep_link::DeepLinkExt;

mod executor_companion;

const DESKTOP_INIT_SCRIPT: &str = concat!(
    include_str!("desktop_notifications_init.js"),
    "\n",
    include_str!("desktop_build_freshness_init.js")
);
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
            app.deep_link()
                .register_all()
                .map_err(|error| Error::new(ErrorKind::Other, error))?;

            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| Error::new(ErrorKind::NotFound, "missing main window config"))?;

            let mut window_config = main_window.clone();
            window_config.url = desktop_webview_url(window_config.url, !cfg!(debug_assertions));
            // macOS provides its own traffic lights. Windows and Linux get the
            // matching controls in the app chrome, so remove their native
            // title-bar buttons instead of showing two competing control sets.
            if cfg!(any(target_os = "linux", target_os = "windows")) {
                window_config.decorations = false;
            }

            WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .initialization_script(format!(
                    "{DESKTOP_INIT_SCRIPT}\nwindow.__nessieDesktopPlatform = {DESKTOP_PLATFORM:?};"
                ))
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Nessie Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                executor_companion::shutdown(app.state::<executor_companion::ExecutorCompanionState>().inner());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{desktop_webview_url, PRODUCTION_ADMIN_URL};
    use tauri::utils::config::WebviewUrl;

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
