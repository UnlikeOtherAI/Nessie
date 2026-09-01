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

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub(super) mod availability;
pub(super) mod integrity;

use availability::{classify_availability, virtualization_available};
use integrity::verified_runtime_directory;

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
    // Closing this pipe on desktop exit tells `serve` to stop all guest
    // sessions before it releases the durable daemon lease.
    _parent_liveness: ChildStdin,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorCompanionStatus {
    pub daemon_status: &'static str,
    pub executor_id: String,
    pub workspace_configured: bool,
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

pub(super) fn runtime_directory(app: &AppHandle) -> Result<PathBuf, String> {
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
    let runtime = runtime_directory(app)?;
    let node = runtime.join("node");
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
    command.arg(runtime.join("nessie-executor.cjs"));
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

fn claim_connection(app: &AppHandle, state_dir: &Path) -> Result<(), String> {
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
    Ok(ManagedExecutorDaemon { child, _parent_liveness: parent_liveness })
}

fn child_status(children: &mut BTreeMap<String, ManagedExecutorDaemon>, executor_id: &str) -> &'static str {
    let is_running = matches!(
        children.get_mut(executor_id).map(|daemon| daemon.child.try_wait()), Some(Ok(None)),
    );
    if !is_running { children.remove(executor_id); "stopped" } else { "running" }
}

fn unowned_daemon_is_stopping(state_dir: &Path) -> bool {
    let lease = state_dir.join(EXECUTOR_DAEMON_LEASE_FILE);
    let Ok(metadata) = fs::symlink_metadata(&lease) else { return false; };
    if metadata.file_type().is_symlink() || !metadata.is_file() { return true; }
    let Ok(value) = fs::read_to_string(lease) else { return true; };
    let Ok(pid) = value.trim().parse::<i32>() else { return true; };
    #[cfg(unix)]
    return unsafe { libc::kill(pid, 0) } == 0;
    #[cfg(not(unix))]
    return true;
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

fn signal_stop(child: &Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        if unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) } != 0 {
            return Err("Nessie Desktop could not request a safe executor shutdown.".to_owned());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = child;
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
    signal_stop(&daemon.child)?;
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
    for daemon in children.values() { let _ = signal_stop(&daemon.child); }
    children.clear();
}
