//! Trusted origin configuration and webview caller verification.

use tauri::WebviewWindow;

const PRODUCTION_ADMIN_ORIGIN: &str = "https://app.nessie.works";
#[cfg(test)]
const DEVELOPMENT_ADMIN_ORIGIN: &str = "http://localhost:5455";

pub(super) fn configured_desktop_origin(debug: bool) -> String {
    if debug {
        let port = std::env::var("NESSIE_ADMIN_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .unwrap_or(5455);
        format!("http://localhost:{port}")
    } else {
        PRODUCTION_ADMIN_ORIGIN.to_owned()
    }
}

pub(super) fn configured_api_origin(debug: bool) -> String {
    if debug {
        let port = std::env::var("NESSIE_API_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .unwrap_or(5454);
        format!("http://127.0.0.1:{port}")
    } else {
        "https://api.nessie.works".to_owned()
    }
}

fn canonical_https_origin(value: &str, allow_local_development: bool) -> Result<String, String> {
    let parsed = tauri::Url::parse(value).map_err(|_| {
        "Nessie Desktop could not verify its configured local inference origin.".to_owned()
    })?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.host_str().is_none_or(str::is_empty)
    {
        return Err(
            "Nessie Desktop could not verify its configured local inference origin.".to_owned(),
        );
    }
    let origin = parsed.origin().ascii_serialization();
    if parsed.scheme() == "https"
        || (allow_local_development
            && parsed.scheme() == "http"
            && matches!(
                parsed.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
            ))
    {
        Ok(origin)
    } else {
        Err("Local inference controls require a TLS-verified Nessie origin.".to_owned())
    }
}

fn assert_local_inference_caller(
    label: &str,
    caller_url: &str,
    configured_origin: &str,
) -> Result<(), String> {
    if label != "main" {
        return Err(
            "Local inference controls are available only from Nessie Desktop's main window."
                .to_owned(),
        );
    }
    let configured = canonical_https_origin(configured_origin, cfg!(debug_assertions))?;
    let caller = tauri::Url::parse(caller_url)
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?
        .origin()
        .ascii_serialization();
    if caller == configured {
        Ok(())
    } else {
        Err(
            "Local inference controls are available only to the configured Nessie origin."
                .to_owned(),
        )
    }
}

pub(super) fn require_local_inference_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    assert_local_inference_caller(
        webview.label(),
        url.as_str(),
        &configured_desktop_origin(cfg!(debug_assertions)),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        assert_local_inference_caller, canonical_https_origin, DEVELOPMENT_ADMIN_ORIGIN,
        PRODUCTION_ADMIN_ORIGIN,
    };

    #[test]
    fn local_inference_controls_require_the_main_window_and_exact_origin() {
        assert!(assert_local_inference_caller(
            "main",
            "https://app.nessie.works/agents",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_ok());
        assert!(assert_local_inference_caller(
            "document-123",
            "https://app.nessie.works/agents",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
        assert!(assert_local_inference_caller(
            "main",
            "https://evil.example/",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
        assert!(assert_local_inference_caller(
            "main",
            "https://app.nessie.works.evil.example/",
            PRODUCTION_ADMIN_ORIGIN
        )
        .is_err());
    }

    #[test]
    fn release_origin_requires_tls_and_an_origin_only() {
        assert_eq!(
            canonical_https_origin(PRODUCTION_ADMIN_ORIGIN, false).unwrap(),
            PRODUCTION_ADMIN_ORIGIN
        );
        assert!(canonical_https_origin("http://app.nessie.works", false).is_err());
        assert!(canonical_https_origin("https://app.nessie.works/path", false).is_err());
        assert!(canonical_https_origin(DEVELOPMENT_ADMIN_ORIGIN, false).is_err());
        assert_eq!(
            canonical_https_origin(DEVELOPMENT_ADMIN_ORIGIN, true).unwrap(),
            DEVELOPMENT_ADMIN_ORIGIN
        );
    }
}
