//! The daemon's host: the same child supervision the desktop shell performs,
//! run by a service account instead of a person's session.
//!
//! Every invocation is the packaged Node running the packaged bundle, with the
//! two environment facts the CLI reads — `NESSIE_EXECUTOR_PACKAGED_CLI=1` arms
//! its own runtime verification, and `NESSIE_EXECUTOR_SUPERVISOR=service` is
//! what makes the descriptor, the server, and the Executors page say which
//! controls apply to this executor id.
//!
//! Stopping is closing the parent-liveness pipe the daemon already watches, and
//! waiting. `TerminateProcess` is never the normal path: a daemon with guests
//! still tearing down is waited for and then refused, never killed.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

use crate::{
    lease::unowned_daemon_is_stopping,
    manifest::VerifiedRuntime,
    paths::{
        executor_state_dir, executors_root, has_executor_state, paired_executors, pending_root,
        PAIRED_BY_FILE,
    },
    protocol::{ExecutorStatus, PairCommand},
};

const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the packaged CLI is given for a one-shot command (`pair`,
/// `connect`, `configure`). Long enough for a slow network round trip, short
/// enough that a wedged child never holds the control pipe open.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

struct ManagedDaemon {
    child: Child,
    /// Closing this pipe tells `serve` to stop all guest sessions before it
    /// releases the durable daemon lease. It has to be droppable while the child
    /// is still held, because closing it *is* the stop request.
    parent_liveness: Option<ChildStdin>,
}

pub struct Supervisor {
    children: BTreeMap<String, ManagedDaemon>,
    root: PathBuf,
    runtime: VerifiedRuntime,
}

/// The argv for one packaged CLI invocation. Split out so what reaches a process
/// list is asserted rather than trusted: a challenge and a workspace path travel
/// on standard input, never here.
pub fn pair_arguments(api_base_url: &str, enrollment_id: &str, state_dir: &Path) -> Vec<String> {
    vec![
        "pair".to_owned(),
        "--api".to_owned(),
        api_base_url.to_owned(),
        "--enrollment".to_owned(),
        enrollment_id.to_owned(),
        "--pair-input-stdin".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}

pub fn serve_arguments(state_dir: &Path) -> Vec<String> {
    vec![
        "serve".to_owned(),
        "--parent-liveness-stdin".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
    ]
}

pub fn configure_arguments(state_dir: &Path, operation_keys: &[String]) -> Vec<String> {
    vec![
        "configure".to_owned(),
        "--state-dir".to_owned(),
        state_dir.display().to_string(),
        "--operations".to_owned(),
        operation_keys.join(","),
    ]
}

fn wait_bounded(child: &mut Child, timeout: Duration) -> Result<Option<i32>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Err(_) => return Err("Nessie Executor could not inspect its packaged command.".to_owned()),
            Ok(Some(status)) => return Ok(Some(status.code().unwrap_or(1))),
            Ok(None) if Instant::now() >= deadline => return Ok(None),
            Ok(None) => sleep(Duration::from_millis(50)),
        }
    }
}

impl Supervisor {
    pub fn new(root: PathBuf, runtime: VerifiedRuntime) -> Self {
        Self { children: BTreeMap::new(), root, runtime }
    }

    pub fn runtime(&self) -> &VerifiedRuntime {
        &self.runtime
    }

    /// The packaged Node running the packaged bundle. Nothing else is ever
    /// executed, and the two supervisor facts are set on every invocation.
    fn command(&self) -> Command {
        let mut command = Command::new(&self.runtime.node_executable);
        command.arg(self.runtime.bundle());
        command.env("NESSIE_EXECUTOR_PACKAGED_CLI", "1");
        command.env("NESSIE_EXECUTOR_SUPERVISOR", "service");
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command
    }

    /// Runs one packaged command to completion. Its output is never captured or
    /// reported: a refusal names what was refused, never what a child printed.
    fn run_to_completion(&self, arguments: Vec<String>, refusal: &str) -> Result<(), String> {
        let mut child = self
            .command()
            .args(arguments)
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        match wait_bounded(&mut child, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            Some(_) => Err(refusal.to_owned()),
            None => {
                // A wedged one-shot command is not a daemon with guests to tear
                // down, and it must not hold the control pipe open forever.
                let _ = child.kill();
                Err(refusal.to_owned())
            }
        }
    }

    fn child_status(&mut self, executor_id: &str) -> &'static str {
        let running =
            matches!(self.children.get_mut(executor_id).map(|daemon| daemon.child.try_wait()), Some(Ok(None)));
        if running {
            "running"
        } else {
            self.children.remove(executor_id);
            "stopped"
        }
    }

    fn state_dir(&self, executor_id: &str) -> Result<PathBuf, String> {
        executor_state_dir(&self.root, executor_id)
    }

    pub fn status(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        let local = self.child_status(executor_id);
        if local == "stopped" && unowned_daemon_is_stopping(&state_dir) {
            return Ok("stopping".to_owned());
        }
        Ok(local.to_owned())
    }

    /// Every paired executor and the state its daemon is in.
    pub fn statuses(&mut self) -> Vec<ExecutorStatus> {
        paired_executors(&self.root)
            .into_iter()
            .filter_map(|executor_id| {
                let daemon_status = self.status(&executor_id).ok()?;
                Some(ExecutorStatus { daemon_status, executor_id, workspace_configured: true })
            })
            .collect()
    }

    pub fn start(&mut self, executor_id: &str) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This executor has not been paired on this computer.".to_owned());
        }
        if self.child_status(executor_id) == "running" {
            return Ok("running".to_owned());
        }
        if unowned_daemon_is_stopping(&state_dir) {
            return Err(
                "The prior daemon is still tearing down. Wait for it to finish before starting again."
                    .to_owned(),
            );
        }
        self.run_to_completion(
            vec!["connect".to_owned(), "--state-dir".to_owned(), state_dir.display().to_string()],
            "Confirm this executor's fingerprint in Nessie before starting its daemon.",
        )?;
        let mut command = self.command();
        command.args(serve_arguments(&state_dir));
        command.stdin(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| "Nessie Executor could not start the executor daemon.".to_owned())?;
        let parent_liveness = child
            .stdin
            .take()
            .ok_or_else(|| "Nessie Executor could not supervise the executor daemon.".to_owned())?;
        self.children.insert(
            executor_id.to_owned(),
            ManagedDaemon { child, parent_liveness: Some(parent_liveness) },
        );
        Ok("running".to_owned())
    }

    pub fn stop(&mut self, executor_id: &str) -> Result<String, String> {
        let Some(mut daemon) = self.children.remove(executor_id) else {
            return Ok("stopped".to_owned());
        };
        if daemon
            .child
            .try_wait()
            .map_err(|_| "Nessie Executor could not inspect the executor daemon.".to_owned())?
            .is_some()
        {
            return Ok("stopped".to_owned());
        }
        // Dropping the pipe closes the daemon's stdin, which is its shutdown
        // request. A second stop finds it already taken and is a no-op.
        daemon.parent_liveness.take();
        if wait_bounded(&mut daemon.child, STOP_TIMEOUT)?.is_some() {
            return Ok("stopped".to_owned());
        }
        self.children.insert(executor_id.to_owned(), daemon);
        Err("The executor is still stopping. Nessie Executor will not force-kill a sandbox daemon."
            .to_owned())
    }

    pub fn configure(
        &mut self,
        executor_id: &str,
        operation_keys: &[String],
    ) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) {
            return Err("This executor has not been paired on this computer.".to_owned());
        }
        let was_running = self.status(executor_id)? == "running";
        if was_running {
            self.stop(executor_id)?;
        }
        self.run_to_completion(
            configure_arguments(&state_dir, operation_keys),
            "The local executor policy was rejected. No command output was retained.",
        )?;
        if was_running {
            self.start(executor_id)
        } else {
            Ok("stopped".to_owned())
        }
    }

    /// Pairs into a staging directory named by the enrollment id, because only
    /// the API can name the executor id and it does so in its reply. The
    /// directory moves to its executor id once the state file names one, which
    /// is what keeps `executors\<executorId>` the whole on-disk vocabulary.
    pub fn pair(
        &mut self,
        command: &PairCommand,
        paired_by: Option<&str>,
        secure_directory: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<String, String> {
        let staging = pending_root(&self.root).join(&command.enrollment_id);
        let _ = fs::remove_dir_all(&staging);
        secure_directory(&staging)?;
        let outcome = self.run_pair(command, &staging);
        if outcome.is_err() {
            let _ = fs::remove_dir_all(&staging);
            return outcome.map(|_| String::new());
        }
        let executor_id = self.promote(&staging, paired_by)?;
        Ok(executor_id)
    }

    fn run_pair(&self, command: &PairCommand, staging: &Path) -> Result<(), String> {
        let mut spawned = self
            .command()
            .args(pair_arguments(command.api_base_url, &command.enrollment_id, staging))
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        let mut standard_input = spawned
            .stdin
            .take()
            .ok_or_else(|| "Nessie Executor could not provide the pairing challenge securely.".to_owned())?;
        let input = serde_json::to_vec(&serde_json::json!({
            "challenge": command.challenge,
            "workspaceRoot": command.workspace_root,
        }))
        .map_err(|_| "Nessie Executor could not prepare the local pairing input.".to_owned())?;
        standard_input
            .write_all(&input)
            .map_err(|_| "Nessie Executor could not provide the pairing challenge securely.".to_owned())?;
        drop(standard_input);
        match wait_bounded(&mut spawned, COMMAND_TIMEOUT)? {
            Some(0) => Ok(()),
            _ => {
                let _ = spawned.kill();
                Err("Nessie executor pairing was rejected. No pairing output was retained.".to_owned())
            }
        }
    }

    /// Reads the executor id the API assigned and moves the staged state under
    /// it. An id already in use is refused rather than overwritten: that state
    /// directory holds another pairing's machine key.
    fn promote(&self, staging: &Path, paired_by: Option<&str>) -> Result<String, String> {
        let state: serde_json::Value = serde_json::from_slice(
            &fs::read(staging.join(crate::paths::EXECUTOR_STATE_FILE))
                .map_err(|_| "Nessie executor pairing left no usable state.".to_owned())?,
        )
        .map_err(|_| "Nessie executor pairing left no usable state.".to_owned())?;
        let executor_id = state
            .get("executorId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Nessie executor pairing left no usable state.".to_owned())?
            .to_owned();
        let destination = executor_state_dir(&self.root, &executor_id)?;
        if destination.exists() {
            return Err("This executor is already paired on this computer.".to_owned());
        }
        fs::create_dir_all(executors_root(&self.root))
            .map_err(|_| "Nessie Executor could not store the new executor's state.".to_owned())?;
        fs::rename(staging, &destination)
            .map_err(|_| "Nessie Executor could not store the new executor's state.".to_owned())?;
        if let Some(sid) = paired_by {
            fs::write(destination.join(PAIRED_BY_FILE), format!("{sid}\n"))
                .map_err(|_| "Nessie Executor could not record the pairing account.".to_owned())?;
        }
        Ok(executor_id)
    }

    /// Asks every daemon to stop, without waiting. The service reports
    /// `STOP_PENDING` while [`Self::still_running`] answers above zero.
    pub fn request_shutdown(&mut self) {
        for daemon in self.children.values_mut() {
            daemon.parent_liveness.take();
        }
    }

    pub fn still_running(&mut self) -> usize {
        self.children.retain(|_, daemon| matches!(daemon.child.try_wait(), Ok(None)));
        self.children.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{configure_arguments, pair_arguments, serve_arguments};
    use std::path::Path;

    #[test]
    fn pairing_arguments_keep_sensitive_input_off_the_process_list() {
        let arguments = pair_arguments(
            "https://api.nessie.works",
            "00000000-0000-4000-8000-000000000001",
            Path::new("/service/state"),
        );
        assert!(arguments.contains(&"--pair-input-stdin".to_owned()));
        assert!(!arguments.iter().any(|argument| argument.contains("challenge-value")));
        assert!(!arguments.iter().any(|argument| argument.contains("workspace")));
    }

    #[test]
    fn the_daemon_is_started_with_the_liveness_pipe_that_stops_it() {
        // Closing this pipe is the whole Windows stop path; a `serve` without
        // the flag would have to be terminated instead.
        assert_eq!(
            serve_arguments(Path::new("/service/state")),
            vec!["serve", "--parent-liveness-stdin", "--state-dir", "/service/state"],
        );
    }

    #[test]
    fn a_policy_is_passed_as_the_canonical_comma_separated_list() {
        assert_eq!(
            configure_arguments(
                Path::new("/service/state"),
                &["file.read".to_owned(), "sandbox.stop".to_owned()],
            ),
            vec!["configure", "--state-dir", "/service/state", "--operations", "file.read,sandbox.stop"],
        );
    }
}
