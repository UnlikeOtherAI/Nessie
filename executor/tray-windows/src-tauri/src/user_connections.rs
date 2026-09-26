//! User-session connections share the CLI's owner-only state and never read its keys.
//! Existing Windows service connections still use their authenticated control pipe.
use std::{
    collections::BTreeMap, fs, path::PathBuf, process::{Child, ChildStdin, Stdio},
    sync::{Mutex, OnceLock}, time::Duration,
};
use nessie_windows_common::lease::unowned_daemon_is_stopping;
use crate::{pipe_client::ServiceResponse, state::ExecutorStatus, user_runtime};

struct Daemon { child: Child, liveness: Option<ChildStdin> }
#[derive(Default)]
struct Connections { daemons: BTreeMap<String, Daemon> }
static CONNECTIONS: OnceLock<Mutex<Connections>> = OnceLock::new();

fn root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Windows reported no user profile.")?)
        .join(".local/state/nessie-executor"))
}

fn directory(id: &str) -> Result<PathBuf, String> {
    if id.len() != 36 || !id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("Invalid executor identity.".into());
    }
    Ok(root()?.join(id))
}

pub fn owns(id: &str) -> bool {
    directory(id).is_ok_and(|path| {
        [path.clone(), path.join("executor-state.json")].iter().enumerate().all(|(index, entry)| {
            fs::symlink_metadata(entry).is_ok_and(|meta| !meta.file_type().is_symlink()
                && if index == 0 { meta.is_dir() } else { meta.is_file() })
        })
    })
}

fn ids() -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(root()?) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not list this account's paired teams.".into()),
    };
    let mut ids: Vec<_> = entries.filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|id| owns(id)).collect();
    ids.sort();
    Ok(ids)
}

impl Connections {
    fn statuses(&mut self) -> Result<Vec<ExecutorStatus>, String> {
        ids()?.into_iter().map(|id| {
            let state_dir = directory(&id)?;
            let state = if let Some(daemon) = self.daemons.get_mut(&id) {
                match daemon.child.try_wait().map_err(|_| "Could not inspect the executor process.")? {
                    None if daemon.liveness.is_some() => "running",
                    None => "stopping",
                    Some(_) => "stopped",
                }
            } else if unowned_daemon_is_stopping(&state_dir) { "running elsewhere" } else { "stopped" };
            Ok(ExecutorStatus { executor_id: id, daemon_status: state.into(), workspace_configured: true })
        }).collect()
    }

    fn start(&mut self, id: &str) -> Result<(), String> {
        if !owns(id) { return Err("This team is not paired under this account.".into()); }
        if let Some(daemon) = self.daemons.get_mut(id) {
            if daemon.child.try_wait().map_err(|error| error.to_string())?.is_none() {
                return if daemon.liveness.is_some() { Ok(()) } else { Err("The executor is still stopping.".into()) };
            }
        }
        let state_dir = directory(id)?;
        if unowned_daemon_is_stopping(&state_dir) {
            return Err("This connection is running in another app or CLI. Stop it there first.".into());
        }
        let path = state_dir.display().to_string();
        user_runtime::run(&["connect".into(), "--state-dir".into(), path.clone()], None)?;
        let mut child = user_runtime::command()?.args(["serve", "--parent-liveness-stdin", "--state-dir", &path])
            .stdin(Stdio::piped()).spawn().map_err(|_| "Could not start the executor daemon.")?;
        let liveness = child.stdin.take();
        self.daemons.insert(id.into(), Daemon { child, liveness });
        Ok(())
    }

    fn stop(&mut self, id: &str) -> Result<(), String> {
        let Some(daemon) = self.daemons.get_mut(id) else {
            return if unowned_daemon_is_stopping(&directory(id)?) {
                Err("Stop this connection in the app or CLI that started it.".into())
            } else { Ok(()) };
        };
        daemon.liveness.take();
        // Never kill a daemon whose guests may still be tearing down.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while daemon.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            if std::time::Instant::now() >= deadline { return Err("The executor is still stopping. Try again shortly.".into()); }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.daemons.remove(id);
        Ok(())
    }

    fn request(&mut self, request: &serde_json::Value) -> Result<ServiceResponse, String> {
        let command = request["command"].as_str().ok_or("Missing executor command.")?;
        let id = request["executorId"].as_str();
        match command {
            "status" => Ok(ServiceResponse::Status(self.statuses()?)),
            "start" | "stop" => {
                let id = id.ok_or("Select a paired team.")?;
                if command == "start" { self.start(id)?; } else { self.stop(id)?; }
                Ok(ServiceResponse::Status(self.statuses()?))
            }
            "describe" | "configureInput" => {
                let id = id.ok_or("Select a paired team.")?;
                let path = directory(id)?.display().to_string();
                if !owns(id) { return Err("This team is not paired under this account.".into()); }
                if command == "configureInput" {
                    let was_running = self.daemons.get_mut(id).is_some_and(|daemon| {
                        daemon.liveness.is_some() && matches!(daemon.child.try_wait(), Ok(None))
                    });
                    self.stop(id)?;
                    let result = user_runtime::run(&["configure".into(), "--configuration-input-stdin".into(),
                        "--state-dir".into(), path.clone()], Some(&request["configurationInput"]));
                    // A rejected edit also restores the previous running connection.
                    let restart = if was_running { self.start(id) } else { Ok(()) };
                    result?;
                    restart?;
                }
                Ok(ServiceResponse::Describe(user_runtime::run(
                    &["describe".into(), "--state-dir".into(), path], None)?))
            }
            "pairingStart" | "pairingStatus" | "pairingConfirm" | "pairingCancel" => {
                let cli = match command {
                    "pairingStart" => "pairing-start", "pairingConfirm" => "pairing-confirm",
                    "pairingCancel" => "pairing-cancel", _ => "pairing-status",
                };
                let mut args = vec![cli.into(), "--json".into()];
                if let Some(id) = id { args.extend(["--executor".into(), id.into()]); }
                let input = if command == "pairingStart" {
                    if request["replace"].as_bool() == Some(true) {
                        return Err("Add a new team connection; manage an existing connection locally.".into());
                    }
                    args.extend(["--api".into(), request["apiBaseUrl"].as_str().ok_or("Choose a server.")?.into(),
                        "--pairing-input-stdin".into()]);
                    Some(serde_json::json!({"workspaceRoot": request["workspaceRoot"]}))
                } else { None };
                if command == "pairingConfirm" {
                    args.extend(["--claim-digest".into(), request["claimDigest"].as_str().ok_or("Review the team first.")?.into()]);
                }
                let view = user_runtime::run(&args, input.as_ref())?;
                // Pairing succeeded even if the network drops before the daemon can connect.
                if command == "pairingConfirm" {
                    if let Some(id) = view["executorId"].as_str() { let _ = self.start(id); }
                }
                Ok(ServiceResponse::Pairing(view))
            }
            _ => Err("Unsupported local executor command.".into()),
        }
    }
}

pub fn call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    CONNECTIONS.get_or_init(|| Mutex::new(Connections::default())).lock()
        .map_err(|_| "Could not access the local executor controller.")?.request(request)
}

pub fn start_paired() {
    std::thread::spawn(|| {
        if let Ok(mut connections) = CONNECTIONS.get_or_init(|| Mutex::new(Connections::default())).lock() {
            for id in ids().unwrap_or_default() { let _ = connections.start(&id); }
        }
    });
}
