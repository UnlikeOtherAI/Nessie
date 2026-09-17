//! One-shot packaged CLI commands owned by the Windows service supervisor.

use std::{fs, io::{Read, Write}, path::Path, process::Stdio};

use crate::{paths::{executor_state_dir, executors_root, has_executor_state, pending_root, PAIRED_BY_FILE}, protocol::PairCommand, supervisor::{configure_arguments, configure_input_arguments, describe_arguments, pair_arguments, parse_fingerprint, wait_bounded, Supervisor, COMMAND_TIMEOUT}};

impl Supervisor {
    pub fn configure(&mut self, executor_id: &str, operation_keys: &[String]) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) { return Err("This executor has not been paired on this computer.".to_owned()); }
        let was_started = self.desired.contains(executor_id) || self.connections.contains_key(executor_id);
        if was_started { self.stop(executor_id)?; }
        self.run_to_completion(configure_arguments(&state_dir, operation_keys), "The local executor policy was rejected. No command output was retained.")?;
        if was_started { self.start(executor_id) } else { Ok("stopped".to_owned()) }
    }

    pub fn describe(&mut self, executor_id: &str) -> Result<serde_json::Value, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) { return Err("This executor has not been paired on this computer.".to_owned()); }
        let output = self.run_to_completion_with_output(describe_arguments(&state_dir), "This executor's local state could not be read.")?;
        serde_json::from_str(&output).map_err(|_| "the service answered in a shape this tray does not understand".to_owned())
    }

    pub fn configure_input(&mut self, executor_id: &str, input: serde_json::Value) -> Result<String, String> {
        let state_dir = self.state_dir(executor_id)?;
        if !has_executor_state(&state_dir) { return Err("This executor has not been paired on this computer.".to_owned()); }
        let was_started = self.desired.contains(executor_id) || self.connections.contains_key(executor_id);
        if was_started { self.stop(executor_id)?; }
        self.run_to_completion_with_input(configure_input_arguments(&state_dir), input, "The local executor policy was rejected. No command output was retained.")?;
        if was_started { self.start(executor_id) } else { Ok("stopped".to_owned()) }
    }

    pub fn pair(&mut self, command: &PairCommand, paired_by: Option<&str>, secure: impl Fn(&Path) -> Result<(), String>) -> Result<(String, String), String> {
        let staging = pending_root(&self.root).join(&command.enrollment_id);
        let _ = fs::remove_dir_all(&staging); secure(&staging)?;
        let output = self.run_pair(command, &staging).inspect_err(|_| { let _ = fs::remove_dir_all(&staging); })?;
        let fingerprint = parse_fingerprint(&output).ok_or_else(|| "Nessie executor pairing succeeded but returned no fingerprint.".to_owned())?;
        Ok((self.promote(&staging, paired_by)?, fingerprint))
    }

    fn run_pair(&self, command: &PairCommand, staging: &Path) -> Result<String, String> {
        let mut child = self.command().args(pair_arguments(&command.api_base_url, &command.enrollment_id, staging)).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().map_err(|_| "Nessie Executor could not start its packaged command.".to_owned())?;
        let mut stdin = child.stdin.take().ok_or_else(|| "Nessie Executor could not provide the pairing challenge securely.".to_owned())?;
        stdin.write_all(&serde_json::to_vec(&serde_json::json!({"challenge": command.challenge, "workspaceRoot": command.workspace_root})).map_err(|_| "Nessie Executor could not prepare the local pairing input.".to_owned())?).map_err(|_| "Nessie Executor could not provide the pairing challenge securely.".to_owned())?; drop(stdin);
        let outcome = wait_bounded(&mut child, COMMAND_TIMEOUT)?; let mut output = String::new(); if let Some(mut stdout) = child.stdout.take() { let _ = stdout.read_to_string(&mut output); }
        if outcome == Some(0) { Ok(output) } else { let _ = child.kill(); Err("Nessie executor pairing was rejected. No pairing output was retained.".to_owned()) }
    }

    fn promote(&self, staging: &Path, paired_by: Option<&str>) -> Result<String, String> {
        let state: serde_json::Value = serde_json::from_slice(&fs::read(staging.join(crate::paths::EXECUTOR_STATE_FILE)).map_err(|_| "Nessie executor pairing left no usable state.".to_owned())?).map_err(|_| "Nessie executor pairing left no usable state.".to_owned())?;
        let executor_id = state.get("executorId").and_then(serde_json::Value::as_str).ok_or_else(|| "Nessie executor pairing left no usable state.".to_owned())?.to_owned();
        let destination = executor_state_dir(&self.root, &executor_id)?; if destination.exists() { return Err("This executor is already paired on this computer.".to_owned()); }
        fs::create_dir_all(executors_root(&self.root)).map_err(|_| "Nessie Executor could not store the new executor's state.".to_owned())?; fs::rename(staging, &destination).map_err(|_| "Nessie Executor could not store the new executor's state.".to_owned())?;
        if let Some(sid) = paired_by { fs::write(destination.join(PAIRED_BY_FILE), format!("{sid}\n")).map_err(|_| "Nessie Executor could not record the pairing account.".to_owned())?; }
        Ok(executor_id)
    }
}
