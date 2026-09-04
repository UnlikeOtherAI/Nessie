use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(super) mod availability;
pub(super) mod integrity;
/// The Win32 process-handle probe behind `daemon_is_live` on Windows.
#[cfg(windows)]
mod windows_process;

use availability::{classify_availability, virtualization_available};
use integrity::{verified_runtime_directory, VerifiedRuntime};

pub use availability::{CompanionAvailability, ExecutorCompanionAvailability};

const EXECUTOR_DIRECTORY: &str = "executors";
const EXECUTOR_STATE_FILE: &str = "executor-state.json";
const EXECUTOR_DAEMON_LEASE_FILE: &str = "daemon.pid";
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct ExecutorCompanionState {
    children: Mutex<BTreeMap<String, ManagedExecutorDaemon>>,
}

struct ManagedExecutorDaemon {
    child: Child,
    // Closing this pipe tells `serve` to stop all guest sessions before it
    // releases the durable daemon lease. On desktop exit that happens by drop;
    // on Windows, where there is no signal to send, closing it *is* the stop
    // request, so it has to be droppable while the child is still held.
    // Unix never reads it: `SIGTERM` is the stop there and the pipe only has to
    // stay open until the struct drops.
    #[cfg_attr(not(windows), allow(dead_code))]
    parent_liveness: Option<ChildStdin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorCompanionStatus {
    pub daemon_status: &'static str,
    pub executor_id: String,
    pub operation_keys: Vec<String>,
    pub workspace_configured: bool,
    pub workspace_label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStateSummary {
    descriptor: LocalDescriptorSummary,
    workspace_root: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalDescriptorSummary {
    operation_keys: Vec<String>,
}

fn private_workspace_label(workspace: &Path) -> String {
    workspace.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Selected filesystem root")
        .to_owned()
}

pub(super) fn local_policy_summary(state_dir: &Path) -> Result<(String, Vec<String>), String> {
    let path = state_dir.join(EXECUTOR_STATE_FILE);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Nessie Desktop could not read this executor's local policy.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Nessie Desktop executor state must be an ordinary file.".to_owned());
    }
    let state: LocalStateSummary = serde_json::from_slice(
        &fs::read(path)
            .map_err(|_| "Nessie Desktop could not read this executor's local policy.".to_owned())?,
    )
    .map_err(|_| "Nessie Desktop executor state is malformed.".to_owned())?;
    Ok((private_workspace_label(&state.workspace_root), state.descriptor.operation_keys))
}

pub(super) fn forget_local_pairing(state_dir: &Path) -> Result<(), String> {
    let runtime_directory = state_dir.join("runtime");
    if let Ok(metadata) = fs::symlink_metadata(&runtime_directory) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Nessie Desktop executor runtime state must be an ordinary directory.".to_owned());
        }
        if fs::read_dir(&runtime_directory)
            .map_err(|_| "Nessie Desktop could not inspect local executor drafts.".to_owned())?
            .next()
            .is_some()
        {
            return Err("Remove every local draft and stop every sandbox before forgetting this pairing.".to_owned());
        }
        fs::remove_dir(&runtime_directory)
            .map_err(|_| "Nessie Desktop could not remove empty executor runtime state.".to_owned())?;
    }
    let state_file = state_dir.join(EXECUTOR_STATE_FILE);
    let metadata = fs::symlink_metadata(&state_file)
        .map_err(|_| "This executor has not been paired on this Nessie Desktop device.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Nessie Desktop executor state must be an ordinary file.".to_owned());
    }
    fs::remove_file(state_file)
        .map_err(|_| "Nessie Desktop could not forget the local executor pairing.".to_owned())?;
    // A future state revision may add another local-only leaf. Removing the
    // directory is therefore best-effort; deleting the exact key-bearing state
    // file above is the operation's security boundary.
    let _ = fs::remove_dir(state_dir);
    Ok(())
}

pub(super) fn executor_state_dir(app: &AppHandle, executor_id: &str) -> Result<PathBuf, String> {
    super::identifier(executor_id, "executor id")?;
    let state_dir = companion_root(app)?.join(executor_id);
    if state_dir.exists() {
        let metadata = fs::symlink_metadata(&state_dir)
            .map_err(|_| "Nessie Desktop could not verify executor state.".to_owned())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Nessie Desktop executor state must be an ordinary directory.".to_owned());
        }
    }
    Ok(state_dir)
}

pub(super) fn has_executor_state(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
        && fs::symlink_metadata(path.join(EXECUTOR_STATE_FILE))
            .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            .unwrap_or(false)
}

pub(super) fn companion_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Nessie Desktop could not resolve its private application-data directory.".to_owned())?
        .join(EXECUTOR_DIRECTORY);
    fs::create_dir_all(&root)
        .map_err(|_| "Nessie Desktop could not create its private executor directory.".to_owned())?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|_| "Nessie Desktop could not verify its private executor directory.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Nessie Desktop executor storage must be an ordinary directory.".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Nessie Desktop could not secure its private executor directory.".to_owned())?;
    }
    Ok(root)
}

pub(super) fn verified_runtime(app: &AppHandle) -> Result<VerifiedRuntime, String> {
    verified_runtime_directory(app).map_err(|failure| failure.reason)
}

/// What this computer can do as an executor, decided from the packaged runtime,
/// the release-provenance check, and local virtualization. It never fails: a
/// companion that cannot run here has to say so, not disappear.
pub(super) fn companion_availability(app: &AppHandle) -> (CompanionAvailability, String) {
    let platform = crate::shell::desktop_platform();
    let runtime = verified_runtime_directory(app).err();
    classify_availability(
        platform,
        runtime.as_ref().map(|failure| (failure.kind, failure.reason.as_str())),
        virtualization_available(),
    )
}

pub(super) fn executor_command(app: &AppHandle) -> Result<Command, String> {
    let runtime = verified_runtime(app)?;
    // The Node binary's file name is whatever the verified manifest declared —
    // `node` on POSIX, `node.exe` on Windows — never a guess from this host.
    let node = runtime.root.join(&runtime.node_executable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&node)
            .map_err(|_| "Nessie Desktop's packaged executor runtime is unavailable.".to_owned())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("Nessie Desktop's packaged executor runtime is not executable.".to_owned());
        }
    }
    let mut command = Command::new(node);
    command.arg(runtime.root.join("nessie-executor.cjs"));
    command.env("NESSIE_EXECUTOR_PACKAGED_CLI", "1");
    // Which supervisor owns this executor id decides which controls a person is
    // offered, so the desktop names itself on every invocation.
    command.env("NESSIE_EXECUTOR_SUPERVISOR", "desktop");
    #[cfg(debug_assertions)]
    command.env("NESSIE_EXECUTOR_ALLOW_LOCAL_API", "1");
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    Ok(command)
}

pub(super) fn pair_arguments(api_base_url: &str, enrollment_id: &str, state_dir: &Path) -> Vec<String> {
    vec![
        "pair".to_owned(), "--api".to_owned(), api_base_url.to_owned(),
        "--enrollment".to_owned(), enrollment_id.to_owned(),
        "--pair-input-stdin".to_owned(), "--state-dir".to_owned(), state_dir.display().to_string(),
    ]
}

pub(super) fn run_pair(
    app: &AppHandle, api_base_url: &str, enrollment_id: &str, challenge: &str,
    state_dir: &Path, workspace: &Path,
) -> Result<(), String> {
    let mut command = executor_command(app)?;
    command.args(pair_arguments(api_base_url, enrollment_id, state_dir));
    command.stdin(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Nessie Desktop could not start its packaged executor companion.".to_owned())?;
    let mut standard_input = child.stdin.take()
        .ok_or_else(|| "Nessie Desktop could not provide the pairing challenge securely.".to_owned())?;
    let input = serde_json::to_vec(&serde_json::json!({ "challenge": challenge, "workspaceRoot": workspace }))
        .map_err(|_| "Nessie Desktop could not prepare the local pairing input.".to_owned())?;
    standard_input.write_all(&input)
        .map_err(|_| "Nessie Desktop could not provide the pairing challenge securely.".to_owned())?;
    drop(standard_input);
    if !child.wait()
        .map_err(|_| "Nessie Desktop could not wait for executor pairing.".to_owned())?
        .success()
    {
        return Err("Nessie executor pairing was rejected. No pairing output was retained.".to_owned());
    }
    Ok(())
}

pub(super) fn run_configure_workspace(
    app: &AppHandle, state_dir: &Path, workspace: &Path, operation_keys: &[String],
) -> Result<(), String> {
    let mut command = executor_command(app)?;
    command.args(["configure", "--configuration-input-stdin", "--state-dir"]);
    command.arg(state_dir);
    command.stdin(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Nessie Desktop could not start its local policy update.".to_owned())?;
    let mut standard_input = child.stdin.take()
        .ok_or_else(|| "Nessie Desktop could not provide the local policy securely.".to_owned())?;
    let input = serde_json::to_vec(&serde_json::json!({
        "operationKeys": operation_keys,
        "workspaceRoot": workspace,
    }))
    .map_err(|_| "Nessie Desktop could not prepare the local policy input.".to_owned())?;
    standard_input.write_all(&input)
        .map_err(|_| "Nessie Desktop could not provide the local policy securely.".to_owned())?;
    drop(standard_input);
    if !child.wait()
        .map_err(|_| "Nessie Desktop could not wait for the local policy update.".to_owned())?
        .success()
    {
        return Err("The local executor policy was rejected. No command output was retained.".to_owned());
    }
    Ok(())
}

pub(super) fn claim_connection(app: &AppHandle, state_dir: &Path) -> Result<(), String> {
    let mut command = executor_command(app)?;
    command.args(["connect", "--state-dir"]);
    command.arg(state_dir);
    if command.status()
        .map_err(|_| "Nessie Desktop could not verify the executor pairing.".to_owned())?
        .success()
    { Ok(()) } else { Err("Confirm this executor's fingerprint in Nessie before starting its daemon.".to_owned()) }
}

fn start_child(app: &AppHandle, state_dir: &Path) -> Result<ManagedExecutorDaemon, String> {
    let mut command = executor_command(app)?;
    command.args(["serve", "--parent-liveness-stdin", "--state-dir"]);
    command.arg(state_dir);
    command.stdin(Stdio::piped());
    let mut child = command.spawn()
        .map_err(|_| "Nessie Desktop could not start the executor daemon.".to_owned())?;
    let parent_liveness = child.stdin.take()
        .ok_or_else(|| "Nessie Desktop could not supervise the executor daemon.".to_owned())?;
    Ok(ManagedExecutorDaemon { child, parent_liveness: Some(parent_liveness) })
}

fn child_status(children: &mut BTreeMap<String, ManagedExecutorDaemon>, executor_id: &str) -> &'static str {
    let is_running = matches!(
        children.get_mut(executor_id).map(|daemon| daemon.child.try_wait()), Some(Ok(None)),
    );
    if !is_running { children.remove(executor_id); "stopped" } else { "running" }
}

/// What a prior daemon's lease file says. A lease that cannot be read the way a
/// daemon writes it is `Suspect`, never absent: something holds that path.
#[derive(Debug, PartialEq, Eq)]
enum DaemonLease {
    Absent,
    Held(u32),
    Suspect,
}

fn read_daemon_lease(state_dir: &Path) -> DaemonLease {
    let lease = state_dir.join(EXECUTOR_DAEMON_LEASE_FILE);
    let Ok(metadata) = fs::symlink_metadata(&lease) else { return DaemonLease::Absent; };
    if metadata.file_type().is_symlink() || !metadata.is_file() { return DaemonLease::Suspect; }
    let Ok(value) = fs::read_to_string(lease) else { return DaemonLease::Suspect; };
    match value.trim().parse::<u32>() {
        Ok(pid) if pid > 0 => DaemonLease::Held(pid),
        _ => DaemonLease::Suspect,
    }
}

/// The decision itself, so the Windows behaviour is testable on any host. Only
/// a lease held by a process that is *still alive* blocks a start: returning
/// `true` for any lease file — as the pre-Windows `not(unix)` arm did — would
/// let one crashed daemon block every later start forever.
fn lease_blocks_start(lease: &DaemonLease, daemon_is_live: impl FnOnce(u32) -> bool) -> bool {
    match lease {
        DaemonLease::Absent => false,
        DaemonLease::Suspect => true,
        DaemonLease::Held(pid) => daemon_is_live(*pid),
    }
}

#[cfg(unix)]
fn daemon_is_live(pid: u32) -> bool {
    let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
    alive == 0
}

#[cfg(windows)]
fn daemon_is_live(pid: u32) -> bool {
    windows_process::process_is_running(pid)
}

#[cfg(not(any(unix, windows)))]
fn daemon_is_live(_pid: u32) -> bool {
    true
}

fn unowned_daemon_is_stopping(state_dir: &Path) -> bool {
    lease_blocks_start(&read_daemon_lease(state_dir), daemon_is_live)
}

pub(super) fn daemon_status(
    state: &ExecutorCompanionState, executor_id: &str, state_dir: &Path,
) -> Result<&'static str, String> {
    let mut children = state.children.lock()
        .map_err(|_| "Nessie Desktop executor state is unavailable.".to_owned())?;
    let local_status = child_status(&mut children, executor_id);
    if local_status == "stopped" && unowned_daemon_is_stopping(state_dir) {
        Ok("stopping")
    } else {
        Ok(local_status)
    }
}

pub(super) fn start_daemon(
    app: &AppHandle, state: &ExecutorCompanionState, executor_id: &str,
) -> Result<&'static str, String> {
    let state_dir = executor_state_dir(app, executor_id)?;
    if !has_executor_state(&state_dir) {
        return Err("This executor has not been paired on this Nessie Desktop device.".to_owned());
    }
    let mut children = state.children.lock()
        .map_err(|_| "Nessie Desktop executor state is unavailable.".to_owned())?;
    if child_status(&mut children, executor_id) == "running" { return Ok("running"); }
    if unowned_daemon_is_stopping(&state_dir) {
        return Err("The prior local daemon is still tearing down. Wait for it to finish before starting again.".to_owned());
    }
    drop(children);
    claim_connection(app, &state_dir)?;
    let mut children = state.children.lock()
        .map_err(|_| "Nessie Desktop executor state is unavailable.".to_owned())?;
    if child_status(&mut children, executor_id) == "running" { return Ok("running"); }
    if unowned_daemon_is_stopping(&state_dir) {
        return Err("The prior local daemon is still tearing down. Wait for it to finish before starting again.".to_owned());
    }
    children.insert(executor_id.to_owned(), start_child(app, &state_dir)?);
    Ok("running")
}

/// Asks the daemon to stop, the way this host has of asking. Unix sends
/// `SIGTERM`; Windows has no signals, so the stop is closing the parent-liveness
/// pipe the daemon already watches (`waitForExecutorDaemonShutdown`). Neither
/// path ever terminates the process: a daemon with guests still tearing down is
/// waited for, and refused after the timeout rather than killed.
fn signal_stop(daemon: &mut ManagedExecutorDaemon) -> Result<(), String> {
    #[cfg(unix)]
    {
        if unsafe { libc::kill(daemon.child.id() as libc::pid_t, libc::SIGTERM) } != 0 {
            return Err("Nessie Desktop could not request a safe executor shutdown.".to_owned());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        // Dropping the pipe closes the daemon's stdin, which is its shutdown
        // request. A second stop finds it already taken and is a no-op.
        daemon.parent_liveness.take();
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = daemon;
        Err("Nessie Desktop executor shutdown is not supported on this platform.".to_owned())
    }
}

pub(super) fn stop_daemon(state: &ExecutorCompanionState, executor_id: &str) -> Result<&'static str, String> {
    let mut children = state.children.lock()
        .map_err(|_| "Nessie Desktop executor state is unavailable.".to_owned())?;
    let Some(mut daemon) = children.remove(executor_id) else { return Ok("stopped"); };
    if daemon.child.try_wait()
        .map_err(|_| "Nessie Desktop could not inspect the executor daemon.".to_owned())?
        .is_some()
    { return Ok("stopped"); }
    signal_stop(&mut daemon)?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if daemon.child.try_wait()
            .map_err(|_| "Nessie Desktop could not inspect the executor daemon.".to_owned())?
            .is_some()
        { return Ok("stopped"); }
        sleep(Duration::from_millis(50));
    }
    children.insert(executor_id.to_owned(), daemon);
    Err("The executor is still stopping. Nessie Desktop will not force-kill a sandbox daemon.".to_owned())
}

pub fn shutdown(state: &ExecutorCompanionState) {
    let Ok(mut children) = state.children.lock() else { return; };
    for daemon in children.values_mut() { let _ = signal_stop(daemon); }
    children.clear();
}

#[cfg(test)]
mod tests {
    use super::{
        lease_blocks_start, private_workspace_label, read_daemon_lease, DaemonLease,
        EXECUTOR_DAEMON_LEASE_FILE,
    };
    use std::fs;

    fn state_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir()
            .join(format!("nessie-lease-{}-{name}", std::process::id()));
        fs::create_dir_all(&path).expect("the test state directory must be creatable");
        path
    }

    fn write_lease(directory: &std::path::Path, contents: &str) {
        fs::write(directory.join(EXECUTOR_DAEMON_LEASE_FILE), contents)
            .expect("the test lease must be writable");
    }

    #[test]
    fn no_lease_never_blocks_a_start() {
        let directory = state_dir("absent");
        fs::remove_file(directory.join(EXECUTOR_DAEMON_LEASE_FILE)).ok();
        assert_eq!(read_daemon_lease(&directory), DaemonLease::Absent);
        assert!(!lease_blocks_start(&DaemonLease::Absent, |_| true));
        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn workspace_label_exposes_only_the_selected_leaf() {
        let workspace = std::path::Path::new("/Users/person/Private client");
        assert_eq!(private_workspace_label(workspace), "Private client");
        assert!(!private_workspace_label(workspace).contains("person"));
    }

    #[test]
    fn a_lease_naming_a_live_daemon_blocks_and_a_dead_one_does_not() {
        let directory = state_dir("held");
        write_lease(&directory, "4242\n");
        assert_eq!(read_daemon_lease(&directory), DaemonLease::Held(4242));
        assert!(lease_blocks_start(&DaemonLease::Held(4242), |pid| {
            assert_eq!(pid, 4242);
            true
        }));
        // The bug this replaces: a stale lease from a crashed daemon used to
        // block every later start forever on any non-Unix host.
        assert!(!lease_blocks_start(&DaemonLease::Held(4242), |_| false));
        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn an_unreadable_or_malformed_lease_is_suspect_and_blocks() {
        let directory = state_dir("suspect");
        for contents in ["", "  ", "0", "-1", "not-a-pid", "12 34"] {
            write_lease(&directory, contents);
            assert_eq!(
                read_daemon_lease(&directory),
                DaemonLease::Suspect,
                "lease {contents:?} must be suspect",
            );
        }
        // A suspect lease never consults liveness: there is no pid to ask about.
        assert!(lease_blocks_start(&DaemonLease::Suspect, |_| {
            panic!("liveness must not be asked about a lease with no pid")
        }));
        fs::remove_dir_all(&directory).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_lease_is_suspect_rather_than_followed() {
        let directory = state_dir("symlink");
        fs::remove_file(directory.join(EXECUTOR_DAEMON_LEASE_FILE)).ok();
        let target = directory.join("elsewhere.pid");
        fs::write(&target, "4242\n").expect("the target must be writable");
        std::os::unix::fs::symlink(&target, directory.join(EXECUTOR_DAEMON_LEASE_FILE))
            .expect("the symlink must be creatable");
        assert_eq!(read_daemon_lease(&directory), DaemonLease::Suspect);
        fs::remove_dir_all(&directory).ok();
    }
}
