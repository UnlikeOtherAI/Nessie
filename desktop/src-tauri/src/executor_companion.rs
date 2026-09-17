use std::{collections::BTreeSet, fs, path::PathBuf};

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod runtime;

use runtime::{
    companion_availability, companion_root, daemon_status, executor_state_dir, forget_local_pairing,
    has_deeptest_source_grant, has_executor_state, local_policy_summary,
    menu_bar_supervises_this_mac, run_configure_workspace, run_pair, start_daemon,
    stop_daemon,
};
use runtime::menu_bar::{
    open_menu_bar_app, resolve_menu_bar_app, MENU_BAR_SUPERVISING_REASON,
};
/// Read by `lib.rs`'s configuration test: the path Desktop opens has to be the
/// path the bundler wrote, and two constants in two file formats is exactly the
/// pair that drifts.
#[cfg(test)]
pub(crate) use runtime::menu_bar::NESTED_MENU_BAR_APP_PATH;

/// The Nessie this computer may pair with, restating
/// `packages/schemas/src/executor-pairing-origins.ts` rather than widening it —
/// the same list the CLI reads for `--api nessie|deeptest|https://…`, and the
/// same one the Mac menu bar app restates in Swift. `pairs_with_the_nessie_a_person_chose`
/// holds these strings against that file so three spellings of two hostnames
/// cannot drift apart quietly.
///
/// It was one pinned origin, because pairing hands a machine key to a server and
/// an app that took any URL was a way to point somebody's machine at a server
/// nobody reviewed. Nessie is open source and people run their own, so the check
/// stays and the choice becomes explicit: two named services, or a person's own
/// HTTPS origin, shown to them by host wherever trust is given.
const PAIRING_PRESETS: [(&str, &str); 2] = [
    ("nessie", "https://api.nessie.works"),
    ("deeptest", "https://api.deeptest.live"),
];
/// The local API a development build may pair with, and only a development build.
const LOCAL_DEVELOPMENT_API_BASE_URL: &str = "http://127.0.0.1:5454";
const WORKSPACE_OPERATION_KEYS: [&str; 5] = [
    "file.list",
    "file.read",
    "file.write",
    "workspace.review",
    "sandbox.stop",
];

pub use runtime::{
    shutdown, ExecutorCompanionAvailability, ExecutorCompanionState, ExecutorCompanionStatus,
    MenuBarCompanion,
};

/// Pairing, starting, stopping and reconfiguring all need a runtime this
/// computer may actually run. The refusal repeats the availability card's own
/// words rather than inventing a second explanation.
fn require_local_control(app: &AppHandle) -> Result<(), String> {
    let (availability, reason) = companion_availability(app);
    if availability.permits_local_control() {
        Ok(())
    } else {
        Err(reason)
    }
}

fn identifier(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(format!("The {field} is malformed."));
    }
    Ok(())
}

/// A release never gains the local development origin: the split is a
/// compile-time fact, not a setting, and a release that could be talked into
/// plain HTTP would not be a release.
fn approved_api_base_url(value: &str) -> Result<String, String> {
    approve_pairing_origin(value, cfg!(debug_assertions))
}

/// May this computer pair with this value, and what exactly would it be pairing
/// with? A preset id resolves to its pinned origin; anything else must be an
/// HTTPS origin carrying no credentials, path, query or fragment — a URL with a
/// path is either a mistake or an attempt to make one host read as another in a
/// label, and neither should reach a machine key.
fn approve_pairing_origin(value: &str, allow_local_development: bool) -> Result<String, String> {
    let trimmed = value.trim();
    if let Some((_, origin)) = PAIRING_PRESETS.iter().find(|(id, _)| *id == trimmed) {
        return Ok((*origin).to_owned());
    }
    let parsed = tauri::Url::parse(trimmed).map_err(|_| {
        "Enter an HTTPS address for the Nessie you are pairing with, such as https://nessie.example.com."
            .to_owned()
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("A pairing address carries no username or password.".to_owned());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() || !matches!(parsed.path(), "" | "/") {
        return Err("A pairing address is an origin only — no path, query or fragment.".to_owned());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(
            "Enter an HTTPS address for the Nessie you are pairing with, such as https://nessie.example.com."
                .to_owned(),
        );
    }
    let origin = parsed.origin().ascii_serialization();
    if parsed.scheme() == "https" {
        return Ok(origin);
    }
    if allow_local_development && origin == LOCAL_DEVELOPMENT_API_BASE_URL {
        return Ok(origin);
    }
    Err(if parsed.scheme() == "http" {
        "A pairing address must be HTTPS. Plain HTTP would expose the pairing challenge on the network."
            .to_owned()
    } else {
        "A pairing address must be HTTPS.".to_owned()
    })
}

/// How the confirmation dialog names the host. A preset is named for its
/// service; anything else is the bare host, because "custom" alone would hide
/// the one fact a person is being asked to confirm.
fn pairing_origin_label(origin: &str) -> String {
    match PAIRING_PRESETS.iter().find(|(_, preset)| *preset == origin) {
        Some(("nessie", _)) => "Nessie".to_owned(),
        Some(("deeptest", _)) => "DeepTest".to_owned(),
        _ => tauri::Url::parse(origin)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| origin.to_owned()),
    }
}

#[cfg(debug_assertions)]
fn assert_approved_companion_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    if url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port_or_known_default() == Some(5455)
    {
        Ok(())
    } else {
        Err("Nessie Desktop companion controls are available only to the approved local admin origin.".to_owned())
    }
}

#[cfg(not(debug_assertions))]
fn assert_approved_companion_caller(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|_| "Nessie Desktop could not verify the caller origin.".to_owned())?;
    if url.scheme() == "https"
        && url.host_str() == Some("app.nessie.works")
        && url.port_or_known_default() == Some(443)
    {
        Ok(())
    } else {
        Err("Nessie Desktop companion controls are available only to the approved Nessie admin origin.".to_owned())
    }
}

fn workspace_operation_keys(operation_keys: Vec<String>) -> Result<Vec<String>, String> {
    if operation_keys.is_empty()
        || operation_keys.len() > WORKSPACE_OPERATION_KEYS.len()
        || operation_keys.iter().any(|key| !WORKSPACE_OPERATION_KEYS.contains(&key.as_str()))
    {
        return Err("Choose one or more supported workspace operations.".to_owned());
    }
    let requested = operation_keys.iter().cloned().collect::<BTreeSet<_>>();
    if requested.len() != operation_keys.len() {
        return Err("Choose each workspace operation only once.".to_owned());
    }
    Ok(WORKSPACE_OPERATION_KEYS
        .iter()
        .filter(|key| requested.contains::<str>(*key))
        .map(|key| (*key).to_owned())
        .collect())
}

async fn confirm(
    app: AppHandle, title: &'static str, message: String, action: &'static str,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(action.to_owned(), "Cancel".to_owned()))
            .blocking_show()
    })
    .await
    .map_err(|_| "Nessie Desktop could not show its native confirmation dialog.".to_owned())
}

async fn choose_workspace(app: AppHandle) -> Result<PathBuf, String> {
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Select the executor's read-only workspace")
            .blocking_pick_folder()
            .map(|path| path.into_path())
    })
    .await
    .map_err(|_| "Nessie Desktop could not open its native workspace picker.".to_owned())?;
    selection
        .transpose()
        .map_err(|_| "Nessie Desktop could not resolve the selected workspace.".to_owned())?
        .ok_or_else(|| "Workspace selection was cancelled.".to_owned())
}

/// Only the caller-origin check refuses here. A computer that cannot run the
/// companion answers with the state it is in and the remedy for it, so the
/// Executors panel explains itself instead of rendering nothing.
#[tauri::command]
pub fn executor_companion_status(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
) -> Result<ExecutorCompanionAvailability, String> {
    assert_approved_companion_caller(&webview)?;
    let (availability, reason) = companion_availability(&app);
    let local_control = availability.permits_local_control();
    let executors = if local_control { paired_executors(&app, &state) } else { Vec::new() };
    Ok(ExecutorCompanionAvailability {
        availability,
        reason,
        platform: crate::shell::desktop_platform(),
        executors,
        menu_bar: MenuBarCompanion {
            // Reported the way the command behaves, not the way the disk looks: a
            // build whose release provenance did not check out refuses to open
            // anything, so it must not offer a control that would then refuse.
            // A sandboxed App Store build ships no nested copy either way.
            openable: local_control && resolve_menu_bar_app().is_some(),
            supervising: local_control && runtime::menu_bar::menu_bar_daemon_live(),
        },
    })
}

/// Opens the Nessie Executor menu bar app, which is the surface that owns this
/// Mac's executor once it is running. Desktop hands over rather than growing a
/// second supervisor.
///
/// The bundle is chosen and verified in `runtime::menu_bar`: a standalone install
/// must carry the pinned Developer ID signature or it is refused, and the nested
/// copy is covered by this application's own signature, which the availability
/// check has already verified. `require_local_control` is what makes that true —
/// a build whose release provenance did not check out offers no executor controls
/// at all, and this is one of them.
#[tauri::command]
pub fn executor_companion_open_menu_bar_app(
    app: AppHandle, webview: WebviewWindow,
) -> Result<(), String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    open_menu_bar_app()
}

fn paired_executors(
    app: &AppHandle, state: &State<'_, ExecutorCompanionState>,
) -> Vec<ExecutorCompanionStatus> {
    let Ok(root) = companion_root(app) else { return Vec::new(); };
    let Ok(entries) = fs::read_dir(root) else { return Vec::new(); };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let state_dir = entry.path();
        if identifier(&name, "executor id").is_ok() && has_executor_state(&state_dir) {
            if let (Ok(daemon_status), Ok((workspace_label, operation_keys))) = (
                daemon_status(state, &name, &state_dir),
                local_policy_summary(&state_dir),
            ) {
                result.push(ExecutorCompanionStatus {
                    daemon_status,
                    executor_id: name,
                    operation_keys,
                    workspace_configured: true,
                    workspace_label,
                });
            }
        }
    }
    result
}

fn has_local_pairing_material(state_dir: &std::path::Path) -> bool {
    has_executor_state(state_dir) || has_deeptest_source_grant(state_dir)
}

#[tauri::command]
pub async fn executor_companion_pair(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    api_base_url: String, challenge: String,
    enrollment_id: String, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    let api_base_url = approved_api_base_url(&api_base_url)?;
    identifier(&enrollment_id, "enrollment id")?;
    identifier(&executor_id, "executor id")?;
    if challenge.is_empty() || challenge.len() > 8_192 || challenge.contains('\0') {
        return Err("The pairing challenge is malformed.".to_owned());
    }
    let workspace = choose_workspace(app.clone()).await?;
    // The host is in the dialog because that is where trust is given: a person
    // confirming this is agreeing that a machine key may be handed to *this*
    // server, and naming it is the only way that is a decision rather than an
    // assumption.
    if !confirm(
        app.clone(),
        "Pair Nessie executor",
        format!(
            "Nessie Desktop will create a private machine key and pair this device with {} ({}). The selected folder stays under the reviewed local policy. File contents and bounded tool output are sent to that Nessie and the configured model provider only when an allowed operation runs.",
            pairing_origin_label(&api_base_url),
            api_base_url,
        ),
        "Pair executor",
    ).await? {
        return Err("Executor pairing was cancelled.".to_owned());
    }
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let api = api_base_url.clone();
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let pair_state_dir = state_dir.clone();
        move || run_pair(&app, &api, &enrollment_id, &challenge, &pair_state_dir, &workspace)
    })
    .await
    .map_err(|_| "Nessie Desktop executor pairing stopped unexpectedly.".to_owned())??;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status: "awaiting_confirmation", executor_id,
        operation_keys, workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_start(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    // Before the confirmation dialog, not after: asking a person to confirm an
    // action that is then refused is worse than not offering it.
    if menu_bar_supervises_this_mac(&state, &executor_id, &executor_state_dir(&app, &executor_id)?)? {
        return Err(MENU_BAR_SUPERVISING_REASON.to_owned());
    }
    if !confirm(
        app.clone(), "Start Nessie executor",
        "Start this locally paired executor. It can perform only operations that you have reviewed in Nessie and allowed in its local policy.".to_owned(),
        "Start executor",
    ).await? {
        return Err("Starting the executor was cancelled.".to_owned());
    }
    let daemon_status = start_daemon(&app, &state, &executor_id)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_stop(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow, executor_id: String,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    // A daemon this Desktop started stays Desktop's to stop, so this only refuses
    // when the running daemon is not one of ours to end.
    if menu_bar_supervises_this_mac(&state, &executor_id, &executor_state_dir(&app, &executor_id)?)? {
        return Err(MENU_BAR_SUPERVISING_REASON.to_owned());
    }
    if !confirm(
        app.clone(), "Stop Nessie executor",
        "Stopping this executor ends its daemon connection and asks every active browser or coding sandbox to tear down.".to_owned(),
        "Stop executor",
    ).await? {
        return Err("Stopping the executor was cancelled.".to_owned());
    }
    let daemon_status = stop_daemon(&state, &executor_id)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_configure_workspace(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String, operation_keys: Vec<String>,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let operation_keys = workspace_operation_keys(operation_keys)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    if !confirm(
        app.clone(), "Update local executor policy",
        format!(
            "Allow these workspace operations locally: {}. This saves a signed policy revision. A running daemon submits it to Nessie now; a stopped daemon submits it when you next start it. It cannot take effect until a person reviews it in Nessie.",
            operation_keys.join(", "),
        ),
        "Save policy",
    ).await? {
        return Err("Updating the local executor policy was cancelled.".to_owned());
    }
    let was_running = daemon_status(&state, &executor_id, &state_dir)? == "running";
    if was_running { stop_daemon(&state, &executor_id)?; }
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let operation_keys = operation_keys.clone();
        let configure_state_dir = state_dir.clone();
        move || {
            let mut command = runtime::executor_command(&app)?;
            command.args(["configure", "--state-dir"]);
            command.arg(&configure_state_dir);
            command.arg("--operations").arg(operation_keys.join(","));
            if command.status()
                .map_err(|_| "Nessie Desktop could not update the local executor policy.".to_owned())?
                .success()
            { Ok(()) } else { Err("The local executor policy was rejected. No command output was retained.".to_owned()) }
        }
    })
    .await
    .map_err(|_| "Nessie Desktop policy configuration stopped unexpectedly.".to_owned())??;
    let daemon_status = if was_running {
        start_daemon(&app, &state, &executor_id)?
    } else {
        "stopped"
    };
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_change_workspace(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String, operation_keys: Vec<String>,
) -> Result<ExecutorCompanionStatus, String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let operation_keys = workspace_operation_keys(operation_keys)?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    let workspace = choose_workspace(app.clone()).await?;
    let workspace_label = workspace.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Selected filesystem root");
    if !confirm(
        app.clone(), "Change executor workspace",
        format!(
            "Use {workspace_label} as this executor's one local workspace folder. The full path stays on this computer. Requested file content and bounded output are sent to Nessie and the configured model provider only when an allowed operation runs. A running daemon submits the new signed revision now; a stopped daemon submits it when you next start it.",
        ),
        "Change workspace",
    ).await? {
        return Err("Changing the executor workspace was cancelled.".to_owned());
    }
    let was_running = daemon_status(&state, &executor_id, &state_dir)? == "running";
    if was_running { stop_daemon(&state, &executor_id)?; }
    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let operation_keys = operation_keys.clone();
        move || run_configure_workspace(&app, &state_dir, &workspace, &operation_keys)
    })
    .await
    .map_err(|_| "Nessie Desktop workspace configuration stopped unexpectedly.".to_owned())??;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let daemon_status = if was_running {
        start_daemon(&app, &state, &executor_id)?
    } else {
        "stopped"
    };
    let (workspace_label, operation_keys) = local_policy_summary(&state_dir)?;
    Ok(ExecutorCompanionStatus { daemon_status, executor_id, operation_keys,
        workspace_configured: true, workspace_label })
}

#[tauri::command]
pub async fn executor_companion_forget(
    app: AppHandle, state: State<'_, ExecutorCompanionState>, webview: WebviewWindow,
    executor_id: String,
) -> Result<(), String> {
    assert_approved_companion_caller(&webview)?;
    require_local_control(&app)?;
    identifier(&executor_id, "executor id")?;
    let state_dir = executor_state_dir(&app, &executor_id)?;
    let has_paired_state = has_executor_state(&state_dir);
    if !has_local_pairing_material(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    if !confirm(
        app, "Forget local executor pairing",
        "Remove this computer's machine key and workspace selection, and permanently delete its local draft copies. This does not delete the executor or its audit history in Nessie; its owner must separately revoke any remaining access there.".to_owned(),
        "Forget pairing",
    ).await? {
        return Err("Forgetting the local executor pairing was cancelled.".to_owned());
    }
    if has_paired_state {
        match daemon_status(&state, &executor_id, &state_dir)? {
            "running" => { stop_daemon(&state, &executor_id)?; },
            "stopping" => return Err(
                "The local daemon is still stopping. Wait for it to finish before forgetting the pairing.".to_owned(),
            ),
            _ => {},
        }
    }
    forget_local_pairing(&state_dir)
}

#[cfg(test)]
mod tests {
    use super::{
        approve_pairing_origin, approved_api_base_url, has_local_pairing_material, identifier,
        pairing_origin_label, runtime::pair_arguments, workspace_operation_keys,
        LOCAL_DEVELOPMENT_API_BASE_URL, PAIRING_PRESETS,
    };
    use std::{fs, path::Path};

    #[test]
    fn accepts_only_safe_executor_identifiers() {
        assert!(identifier("00000000-0000-4000-8000-000000000001", "executor id").is_ok());
        assert!(identifier("../state", "executor id").is_err());
    }

    #[test]
    fn orphaned_source_grant_keeps_forget_available() {
        let directory = std::env::temp_dir().join(format!(
            "nessie-forget-eligibility-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("directory");
        fs::write(directory.join("deeptest-source-grant.json"), "grant").expect("grant");

        assert!(has_local_pairing_material(&directory));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn canonicalizes_workspace_policy_without_browser_or_coding_operations() {
        assert_eq!(
            workspace_operation_keys(vec!["sandbox.stop".to_owned(), "file.read".to_owned()]).unwrap(),
            vec!["file.read", "sandbox.stop"],
        );
        assert!(workspace_operation_keys(vec!["browser.open".to_owned()]).is_err());
    }

    #[test]
    fn pairing_arguments_keep_sensitive_input_off_the_process_list() {
        let arguments = pair_arguments(
            "https://api.nessie.works", "00000000-0000-4000-8000-000000000001", Path::new("/private/state"),
        );
        assert!(arguments.contains(&"--pair-input-stdin".to_owned()));
        assert!(!arguments.iter().any(|argument| argument == "secret-challenge"));
        assert!(!arguments.iter().any(|argument| argument == "/private/workspace"));
    }

    /// The presets are the ones `packages/schemas` names, read rather than
    /// copied: three restatements of two hostnames is exactly the shape that
    /// lets one of them quietly accept a host the others refuse.
    #[test]
    fn pairs_with_the_nessie_a_person_chose() {
        let contract = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/schemas/src/executor-pairing-origins.ts"),
        )
        .expect("the pairing-origin contract");
        for (id, origin) in PAIRING_PRESETS {
            assert!(contract.contains(&format!("id: '{id}'")), "{id} is not a preset in the contract");
            assert!(
                contract.contains(&format!("apiBaseUrl: '{origin}'")),
                "{origin} is not the origin the contract pins",
            );
            assert_eq!(approve_pairing_origin(id, false).unwrap(), origin);
            assert_eq!(approve_pairing_origin(origin, false).unwrap(), origin);
        }
        assert!(contract.contains(&format!(
            "EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN = '{LOCAL_DEVELOPMENT_API_BASE_URL}'"
        )));
        // Somebody's own Nessie, named by its host rather than "custom".
        assert_eq!(
            approve_pairing_origin("https://nessie.example.com/", false).unwrap(),
            "https://nessie.example.com",
        );
        assert_eq!(pairing_origin_label("https://api.nessie.works"), "Nessie");
        assert_eq!(pairing_origin_label("https://api.deeptest.live"), "DeepTest");
        assert_eq!(pairing_origin_label("https://nessie.example.com"), "nessie.example.com");
    }

    #[test]
    fn refuses_what_a_pairing_address_may_never_be() {
        for allow_local_development in [true, false] {
            for value in [
                // Plain HTTP would put the pairing challenge on the network.
                "http://nessie.example.com",
                // A path is how one host is dressed up as another in a label.
                "https://evil.example.com/api.nessie.works",
                "https://nessie.example.com?next=x",
                "https://nessie.example.com#fragment",
                "https://user:pass@nessie.example.com",
                "ftp://nessie.example.com",
                "mailto:someone@nessie.example.com",
                "not a url",
                "api.nessie.works",
                "",
            ] {
                assert!(
                    approve_pairing_origin(value, allow_local_development).is_err(),
                    "{value:?} must be refused",
                );
            }
        }
    }

    #[test]
    fn the_local_api_is_reachable_only_by_a_development_build() {
        assert_eq!(
            approve_pairing_origin(LOCAL_DEVELOPMENT_API_BASE_URL, true).unwrap(),
            LOCAL_DEVELOPMENT_API_BASE_URL,
        );
        assert!(approve_pairing_origin(LOCAL_DEVELOPMENT_API_BASE_URL, false).is_err());
        // The hatch is that one origin, not "any http on loopback".
        for near in ["http://127.0.0.1:9999", "http://localhost:5454", "http://127.0.0.1"] {
            assert!(approve_pairing_origin(near, true).is_err(), "{near} is not the local origin");
        }
        // And this build's own answer follows its configuration, so a release
        // cannot be talked into the development origin.
        assert_eq!(
            approved_api_base_url(LOCAL_DEVELOPMENT_API_BASE_URL).is_ok(),
            cfg!(debug_assertions),
        );
        assert_eq!(approved_api_base_url("nessie").unwrap(), "https://api.nessie.works");
    }
}
