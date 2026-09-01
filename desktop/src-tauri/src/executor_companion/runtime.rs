use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const EXECUTOR_DIRECTORY: &str = "executors";
const EXECUTOR_STATE_FILE: &str = "executor-state.json";
const EXECUTOR_DAEMON_LEASE_FILE: &str = "daemon.pid";
#[cfg(not(debug_assertions))]
const PRODUCTION_SIGNING_TEAM_ID: Option<&str> = option_env!("NESSIE_DESKTOP_SIGNING_TEAM_ID");
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    executor_bundle_sha256: String,
    format: u8,
    node_sha256: String,
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
    #[cfg(debug_assertions)]
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/executor-runtime");
    #[cfg(not(debug_assertions))]
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "Nessie Desktop could not find its packaged executor companion.".to_owned())?
        .join("executor-runtime");
    for name in ["node", "nessie-executor.cjs", "manifest.json", "NODE_LICENSE"] {
        let candidate = root.join(name);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| "Nessie Desktop's packaged executor companion is unavailable.".to_owned())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Nessie Desktop's packaged executor companion is invalid.".to_owned());
        }
    }
    let manifest: RuntimeManifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json"))
            .map_err(|_| "Nessie Desktop's packaged executor companion is invalid.".to_owned())?,
    )
    .map_err(|_| "Nessie Desktop's packaged executor companion is invalid.".to_owned())?;
    if manifest.format != 1
        || manifest.node_sha256 != file_sha256(&root.join("node"))?
        || manifest.executor_bundle_sha256 != file_sha256(&root.join("nessie-executor.cjs"))?
    {
        return Err("Nessie Desktop's packaged executor companion did not pass integrity verification.".to_owned());
    }
    require_release_signature(app, &root)?;
    Ok(root)
}

#[cfg(not(debug_assertions))]
fn require_release_signature(_app: &AppHandle, resource_dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let expected_team = PRODUCTION_SIGNING_TEAM_ID
            .filter(|team| !team.is_empty() && team.bytes().all(|byte| byte.is_ascii_alphanumeric()))
            .ok_or_else(|| "Executor controls require a release build with a pinned Developer ID team.".to_owned())?;
        let bundle = application_bundle_from_resource_dir(resource_dir)?;
        let verified = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "Nessie Desktop could not verify its release signature.".to_owned())?
            .success();
        if !verified {
            return Err("Executor controls require a signed, intact Nessie Desktop release.".to_owned());
        }
        let metadata = Command::new("/usr/bin/codesign")
            .args(["-dvv"])
            .arg(bundle)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| "Nessie Desktop could not inspect its release signature.".to_owned())?;
        let details = String::from_utf8_lossy(&metadata.stderr);
        if details.lines().any(|line| line == format!("TeamIdentifier={expected_team}"))
            && details.lines().any(|line| line.starts_with("Authority=Developer ID Application:"))
        {
            Ok(())
        } else {
            Err("Executor controls require the pinned Developer ID signature.".to_owned())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = resource_dir;
        Err("Nessie Desktop executor controls are currently supported only on signed macOS releases.".to_owned())
    }
}

#[cfg(any(not(debug_assertions), test))]
pub(super) fn application_bundle_from_resource_dir(resource_dir: &Path) -> Result<&Path, String> {
    resource_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "Nessie Desktop could not locate its application bundle.".to_owned())
}

#[cfg(debug_assertions)]
fn require_release_signature(_app: &AppHandle, _resource_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|_| "Nessie Desktop's packaged executor companion is unavailable.".to_owned())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Nessie Desktop could not verify its packaged executor companion.".to_owned())?;
        if read == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..read]);
    }
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
