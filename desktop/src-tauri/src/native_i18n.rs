//! Localized copy for native desktop wrapper controls and confirmations.
//!
//! Language is read from the admin's persisted preference at the command
//! boundary. Unknown or absent locales fall back to British English.

const LANGUAGES: [&str; 7] = ["en-GB", "en-US", "cs", "de", "fr", "it", "es"];

fn source(language: &str) -> &'static str {
    match language {
        "en-US" => include_str!("../locales/en-US/native.json"),
        "cs" => include_str!("../locales/cs/native.json"),
        "de" => include_str!("../locales/de/native.json"),
        "fr" => include_str!("../locales/fr/native.json"),
        "it" => include_str!("../locales/it/native.json"),
        "es" => include_str!("../locales/es/native.json"),
        _ => include_str!("../locales/en-GB/native.json"),
    }
}

pub fn text(language: &str, key: &str) -> String {
    let source = if LANGUAGES.contains(&language) {
        source(language)
    } else {
        source("en-GB")
    };
    serde_json::from_str::<serde_json::Value>(source)
        .ok()
        .and_then(|catalogue| {
            catalogue
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| key.to_owned())
}

pub fn format(language: &str, key: &str, values: &[(&str, &str)]) -> String {
    values
        .iter()
        .fold(text(language, key), |message, (name, value)| {
            message.replace(&format!("{{{name}}}"), value)
        })
}

#[cfg(test)]
mod tests {
    use super::{format, text};

    #[test]
    fn every_supported_language_has_native_confirmation_copy() {
        for language in ["en-GB", "en-US", "cs", "de", "fr", "it", "es"] {
            assert_ne!(text(language, "prepareTitle"), "prepareTitle", "{language}");
            assert_ne!(text(language, "cancel"), "cancel", "{language}");
        }
    }

    #[test]
    fn unknown_language_falls_back_to_british_english() {
        assert_eq!(
            text("unsupported", "prepareTitle"),
            text("en-GB", "prepareTitle")
        );
    }

    #[test]
    fn consent_placeholders_keep_the_canonical_display_values() {
        let message = format(
            "en-GB",
            "consentMessage",
            &[("organization", "Org"), ("account", "Acct")],
        );
        assert!(message.contains("Organization reference: Org"));
        assert!(message.contains("Account reference: Acct"));
    }
}
