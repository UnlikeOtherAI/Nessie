use std::io::{Error, ErrorKind};
use tauri::utils::config::WebviewUrl;
use tauri::Manager;
use tauri::WebviewWindowBuilder;

mod executor_companion;
mod shell;

use shell::{desktop_init_script, desktop_platform, should_register_deep_link_schemes};

const PRODUCTION_ADMIN_URL: &str = "https://app.nessie.works/";

// An embedded Tauri bundle is served from tauri://localhost. Its requests to
// api.nessie.works are third-party in macOS WebKit, which blocks the HttpOnly
// refresh cookie that keeps a short-lived access JWT renewable. Release windows
// must therefore load the hosted admin as their top-level, same-site document.
fn desktop_webview_url(configured: WebviewUrl, release: bool) -> WebviewUrl {
    if !release {
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

    tauri::Builder::default()
        // The single-instance plugin must be registered first, and its
        // deep-link feature is what carries a second launch's `nessie://`
        // callback into the running instance's onOpenUrl listeners.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
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
            shell::desktop_set_badge,
        ])
        .setup(move |app| {
            if should_register_deep_link_schemes(
                std::env::consts::OS,
                std::env::var_os("APPIMAGE").as_deref(),
            ) {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
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
                    app.state::<executor_companion::ExecutorCompanionState>().inner(),
                );
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{desktop_webview_url, PRODUCTION_ADMIN_URL};
    use tauri::utils::config::WebviewUrl;

    #[test]
    fn release_window_uses_the_hosted_same_site_admin() {
        let url = desktop_webview_url(WebviewUrl::App("index.html".into()), true);
        assert_eq!(url.to_string(), PRODUCTION_ADMIN_URL);
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

        if cfg!(debug_assertions) {
            assert_eq!(selected, configured);
        } else {
            assert_eq!(selected.to_string(), PRODUCTION_ADMIN_URL);
        }
    }
}
