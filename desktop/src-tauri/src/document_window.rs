use tauri::utils::config::{WebviewUrl, WindowConfig};
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder};

use crate::shell::{desktop_init_script, desktop_platform};

/// A Knowledge document in a window of its own — what a double-tap in the
/// Documents Finder asks for on the desktop (browser-ui.md §7).
///
/// The window is an ordinary webview on the **caller's own origin**, loading
/// the admin's `/documents/<spaceId>/<pageId>` route. Deriving the origin from
/// the window that asked, rather than from a configured address, is what makes
/// the command safe to expose to loaded web content: the worst a compromised
/// page can ask for is a second window onto itself, and dev, release and any
/// future host are all handled without this file naming any of them.
///
/// It is also why the ids are validated rather than trusted. They are pasted
/// into a path, so anything that could climb out of it (`..`, a slash, a query
/// or a scheme) is refused before the URL is built.
///
/// **The chrome is the main window's own, cloned.** A document window is the
/// same window with a different address, so it takes the platform frame Tauri
/// already merged for `main` — macOS's hidden title over native traffic
/// lights, the undecorated Windows and Linux frames the admin draws itself —
/// rather than restating it here under three `cfg` branches that only ever
/// compile one at a time and could drift on the two nobody built.

/// Every document window's label starts here, which is what the desktop
/// capability's `document-*` glob grants the window API to. A label outside
/// that prefix would open a window the admin's own title bar cannot close.
const LABEL_PREFIX: &str = "document-";

/// A document is read down a column, not across one: narrower than the main
/// window, and allowed to get narrower still.
const WIDTH: f64 = 960.0;
const HEIGHT: f64 = 800.0;
const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 420.0;

/// Long enough for a document title, short enough that a pathological one
/// cannot become the whole taskbar.
const MAX_TITLE_CHARS: usize = 80;

const REFUSED: &str = "Nessie Desktop can only open a document it can name.";

/// An id the shell will paste into a URL path: our own opaque identifiers and
/// nothing else. Deliberately stricter than the ids actually are, because the
/// cost of being too strict is one document opening in place instead of in a
/// window, and the cost of being too loose is an address of somebody else's
/// choosing.
pub fn is_document_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

/// One window per document: the label is the page id, so a second double-tap
/// on the same row finds the window that is already open instead of stacking a
/// copy on top of it.
pub fn document_window_label(page_id: &str) -> Option<String> {
    is_document_id(page_id).then(|| format!("{LABEL_PREFIX}{page_id}"))
}

/// The address the new window loads: the caller's origin, the document's path,
/// and nothing the caller was carrying — `join` on an absolute path drops the
/// caller's own path, query and fragment.
///
/// Only `http` and `https` are answered. An embedded build serves the admin
/// from `tauri://localhost`, where a second top-level document is not the same
/// thing at all; there the command refuses and the admin opens the document in
/// place, which is what that build did before this window existed.
pub fn document_window_url(caller: &Url, space_id: &str, page_id: &str) -> Result<Url, String> {
    if !is_document_id(space_id) || !is_document_id(page_id) {
        return Err(REFUSED.to_owned());
    }
    if !matches!(caller.scheme(), "http" | "https") {
        return Err("Nessie Desktop opens document windows only on a web admin origin.".to_owned());
    }
    caller
        .join(&format!("/documents/{space_id}/{page_id}"))
        .map_err(|_| REFUSED.to_owned())
}

/// The window's name in the taskbar, the Dock menu and the window switcher.
/// The page renames it as soon as it has loaded; this is what the window is
/// called in the moment before that, so an untitled document still gets a
/// window with a name on it.
pub fn window_title(title: &str) -> String {
    let cleaned = title
        .chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return "Document — Nessie".to_owned();
    }
    let clamped = trimmed.chars().take(MAX_TITLE_CHARS).collect::<String>();
    format!("{clamped} — Nessie")
}

/// The main window's configuration with this document's label, address, name
/// and size on it. Everything else — decorations, the macOS title bar style,
/// transparency, the shadow, the background colour — is carried over
/// untouched, which is the whole point of cloning rather than building.
pub fn document_window_config(
    main: &WindowConfig,
    label: String,
    url: Url,
    title: &str,
) -> WindowConfig {
    WindowConfig {
        create: true,
        height: HEIGHT,
        label,
        min_height: Some(MIN_HEIGHT),
        min_width: Some(MIN_WIDTH),
        title: window_title(title),
        url: WebviewUrl::External(url),
        width: WIDTH,
        ..main.clone()
    }
}

/// Open the document, or raise the window already holding it.
///
/// Every refusal is an `Err` the admin can act on: it opens the document in
/// place instead, so a double-tap always lands somewhere. That is also what a
/// Desktop build older than this command does, by answering "no such command".
///
/// **It is `async`, and that is load-bearing on Windows.** `WebviewWindowBuilder`
/// deadlocks when a window is built from a *synchronous* command (its own docs
/// say so, over the WebView2 issue tauri-apps/wry#583). The first version of
/// this command was synchronous, and the symptom was not an error anywhere: the
/// native window appeared with the right title and size, and its webview then
/// sat on `about:blank` forever — no navigation, no initialization script, no
/// `__TAURI_INTERNALS__`. On an undecorated Windows frame, where the admin
/// draws the title bar itself, that is a window with no close button either.
/// `async` moves the build off the IPC thread, which is what lets the webview
/// come up at all.
#[tauri::command]
pub async fn desktop_open_document_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    page_id: String,
    space_id: String,
    title: String,
) -> Result<(), String> {
    let label = document_window_label(&page_id).ok_or_else(|| REFUSED.to_owned())?;
    let caller = webview
        .url()
        .map_err(|_| "Nessie Desktop could not read the calling window's address.".to_owned())?;
    let url = document_window_url(&caller, &space_id, &page_id)?;

    // Already open: a second double-tap means "show me that one", never a
    // second copy of the same document with its own unsaved state.
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.unminimize();
        let _ = open.show();
        let _ = open.set_focus();
        return Ok(());
    }

    let main = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "Nessie Desktop has no main window to take its frame from.".to_owned())?;
    let config = document_window_config(&main, label, url, &title);

    WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|builder| {
            builder
                .initialization_script(desktop_init_script(desktop_platform()))
                .build()
        })
        .map(|_| ())
        .map_err(|error| format!("Nessie Desktop could not open the document window: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        document_window_config, document_window_label, document_window_url, is_document_id,
        window_title, HEIGHT, MIN_HEIGHT, MIN_WIDTH, WIDTH,
    };
    use tauri::utils::config::{WebviewUrl, WindowConfig};
    use tauri::Url;

    fn caller(address: &str) -> Url {
        Url::parse(address).expect("a test caller URL must parse")
    }

    /// The real `main` window, read from the configuration the shell ships —
    /// not a hand-written stand-in, or this would prove nothing about the
    /// frame a document window actually gets.
    fn main_window(source: &str) -> WindowConfig {
        let config: serde_json::Value =
            serde_json::from_str(source).expect("a Tauri config must be valid JSON");
        let window = config["app"]["windows"]
            .as_array()
            .expect("a config under test must declare its windows")
            .iter()
            .find(|window| window["label"] == serde_json::json!("main"))
            .expect("every config must declare the main window")
            .clone();
        serde_json::from_value(window).expect("the main window must deserialize")
    }

    /// The one defect no unit test can provoke and no error reports: a
    /// synchronous command that builds a window deadlocks WebView2, and the
    /// window comes up empty and unclosable instead of failing. Guarding the
    /// keyword is the only cheap way to keep the fix from being undone by
    /// somebody tidying an `async fn` that appears to await nothing.
    #[test]
    fn the_command_that_builds_a_window_stays_async() {
        let source = include_str!("document_window.rs");
        assert!(
            source.contains("pub async fn desktop_open_document_window"),
            "building a window from a synchronous command deadlocks on Windows",
        );
    }

    #[test]
    fn accepts_the_opaque_ids_the_admin_actually_sends() {
        assert!(is_document_id("01JQ8Z3M2K4P6R8T0V2X4Z6A8C"));
        assert!(is_document_id("9f8c1d2e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"));
        assert!(is_document_id("page_42"));
    }

    #[test]
    fn refuses_anything_that_could_climb_out_of_the_path() {
        assert!(!is_document_id(""));
        assert!(!is_document_id(".."));
        assert!(!is_document_id("a/b"));
        assert!(!is_document_id("a?b=c"));
        assert!(!is_document_id("a#b"));
        assert!(!is_document_id("https://evil.example"));
        assert!(!is_document_id(&"a".repeat(65)));
    }

    #[test]
    fn one_label_per_document_so_a_second_tap_finds_the_same_window() {
        assert_eq!(
            document_window_label("page_42"),
            Some("document-page_42".to_owned())
        );
        assert_eq!(
            document_window_label("page_42"),
            document_window_label("page_42")
        );
        assert_eq!(document_window_label("../other"), None);
    }

    #[test]
    fn builds_the_document_route_on_the_callers_own_origin() {
        let url = document_window_url(
            &caller("https://app.nessie.works/knowledge-base/spaces/s1?pageId=p1#top"),
            "space1",
            "page1",
        )
        .expect("a well-formed request must resolve");
        assert_eq!(url.as_str(), "https://app.nessie.works/documents/space1/page1");
    }

    #[test]
    fn keeps_the_development_port_without_naming_it() {
        let url = document_window_url(&caller("http://localhost:5455/knowledge-base"), "s", "p")
            .expect("the dev origin must resolve");
        assert_eq!(url.as_str(), "http://localhost:5455/documents/s/p");
    }

    #[test]
    fn refuses_an_origin_that_is_not_a_web_admin() {
        assert!(document_window_url(&caller("tauri://localhost/index.html"), "s", "p").is_err());
        assert!(document_window_url(&caller("file:///tmp/index.html"), "s", "p").is_err());
    }

    #[test]
    fn refuses_a_request_whose_ids_it_cannot_name() {
        assert!(document_window_url(&caller("https://app.nessie.works/"), "../..", "p").is_err());
        assert!(document_window_url(&caller("https://app.nessie.works/"), "s", "").is_err());
    }

    #[test]
    fn names_the_window_even_when_the_document_has_no_title() {
        assert_eq!(window_title("Quarterly plan"), "Quarterly plan — Nessie");
        assert_eq!(window_title("   "), "Document — Nessie");
        assert_eq!(window_title("two\nlines"), "two lines — Nessie");
        let long = window_title(&"x".repeat(200));
        assert_eq!(long.chars().count(), 80 + " — Nessie".chars().count());
    }

    /// The reason the configuration is cloned rather than rebuilt: on every
    /// platform, a document window wears the frame that platform's `main`
    /// window was given. A `cfg`-branched builder would compile one of those
    /// three statements per build and could be wrong on the other two for as
    /// long as nobody opened them.
    #[test]
    fn a_document_window_wears_every_platforms_own_frame() {
        for source in [
            include_str!("../tauri.conf.json"),
            include_str!("../tauri.macos.conf.json"),
            include_str!("../tauri.windows.conf.json"),
            include_str!("../tauri.linux.conf.json"),
        ] {
            let main = main_window(source);
            let document = document_window_config(
                &main,
                "document-page1".to_owned(),
                Url::parse("https://app.nessie.works/documents/s1/page1").unwrap(),
                "Quarterly plan",
            );
            assert_eq!(document.decorations, main.decorations);
            assert_eq!(document.transparent, main.transparent);
            assert_eq!(document.shadow, main.shadow);
            assert_eq!(document.title_bar_style, main.title_bar_style);
            assert_eq!(document.hidden_title, main.hidden_title);
            assert_eq!(document.background_color, main.background_color);
            assert_eq!(document.resizable, main.resizable);
        }
    }

    #[test]
    fn it_is_the_document_that_differs_from_the_main_window() {
        let main = main_window(include_str!("../tauri.conf.json"));
        let document = document_window_config(
            &main,
            "document-page1".to_owned(),
            Url::parse("https://app.nessie.works/documents/s1/page1").unwrap(),
            "Quarterly plan",
        );
        assert_eq!(document.label, "document-page1");
        assert_eq!(document.title, "Quarterly plan — Nessie");
        assert!(matches!(document.url, WebviewUrl::External(_)));
        assert_eq!((document.width, document.height), (WIDTH, HEIGHT));
        assert_eq!(document.min_width, Some(MIN_WIDTH));
        assert_eq!(document.min_height, Some(MIN_HEIGHT));
        // `main` is declared `create: false` because the shell builds it by
        // hand at startup; a document window is built from this config on the
        // spot and must not inherit that.
        assert!(!main.create);
        assert!(document.create);
    }
}
