//! Code pairing remains inside the provenance-checked service and its private root.
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
};

use crate::{
    helper::secure_directory,
    paths::{executors_root, has_executor_state, paired_executors, pending_root, PAIRED_BY_FILE},
    supervisor::{wait_bounded, Supervisor, COMMAND_TIMEOUT},
};

const PENDING_FILE: &str = "executor-pairing-code.json";

fn pairing_failure(output: &str) -> String {
    let response = serde_json::from_str::<serde_json::Value>(output).ok();
    match response.as_ref().and_then(|value| value.pointer("/error/code")).and_then(serde_json::Value::as_str) {
        Some("workspace_cleanup_required") => "Remove every local draft and stop every sandbox before replacing this pairing or changing its workspace folders.".to_owned(),
        _ => "Nessie could not complete pairing. Check your connection and try again.".to_owned(),
    }
}

impl Supervisor {
    pub fn pairing_connection(&self, executor: &str) -> Result<serde_json::Value, String> {
        let directory = self.state_dir(executor)?;
        if !has_executor_state(&directory) || directory.join(PENDING_FILE).exists() {
            return Err("This connection is not paired yet.".to_owned());
        }
        self.run_pairing(&directory, "status", Vec::new(), None)
    }

    fn pairing_directory(&self) -> Result<PathBuf, String> {
        let pending = pending_root(&self.root).join("machine");
        let mut directories = BTreeSet::new();
        if pending.join(PENDING_FILE).exists() || has_executor_state(&pending) {
            directories.insert(pending.clone());
        }
        if let Ok(entries) = fs::read_dir(executors_root(&self.root)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if crate::protocol::valid_identifier(&name)
                    && entry.path().join(PENDING_FILE).exists()
                {
                    directories.insert(self.state_dir(&name)?);
                }
            }
        }
        if directories.len() > 1 {
            return Err("Several connections are being paired. Finish the pending connections first.".to_owned());
        }
        Ok(directories.into_iter().next().unwrap_or(pending))
    }

    fn run_pairing(
        &self,
        directory: &Path,
        action: &str,
        extra: Vec<String>,
        input: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let mut command = self.command();
        command.args([
            format!("pairing-{action}"),
            "--json".to_owned(),
            "--state-dir".to_owned(),
            directory.display().to_string(),
        ]);
        command.args(extra).stdout(Stdio::piped());
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Nessie Executor could not start pairing.".to_owned())?;
        if let Some(input) = input {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "Pairing could not be started.".to_owned())?;
            stdin
                .write_all(
                    serde_json::to_string(&input)
                        .map_err(|_| "Pairing could not be started.".to_owned())?
                        .as_bytes(),
                )
                .map_err(|_| "Pairing could not be started.".to_owned())?;
        }
        let status = wait_bounded(&mut child, COMMAND_TIMEOUT)?;
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Nessie could not complete pairing. Check your connection and try again."
                    .to_owned(),
            );
        }
        let mut output = String::new();
        child
            .stdout
            .take()
            .ok_or_else(|| "Pairing returned no answer.".to_owned())?
            .take(65_536)
            .read_to_string(&mut output)
            .map_err(|_| "Pairing returned no answer.".to_owned())?;
        if status != Some(0) {
            return Err(pairing_failure(&output));
        }
        serde_json::from_str(&output)
            .map_err(|_| "Pairing returned an unreadable answer.".to_owned())
    }

    pub fn pairing_start(
        &mut self,
        origin: &str,
        workspace: &str,
        replace: bool,
        sid: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let directory = if replace {
            let executors = paired_executors(&self.root);
            if executors.len() != 1 {
                return Err("Choose one connection to remove before replacing it, or add another account.".to_owned());
            }
            let executor = &executors[0];
            let directory = self.state_dir(executor)?;
            self.check_pairing_owner(&directory, sid)?;
            self.stop(executor)?;
            directory
        } else {
            self.pairing_directory()?
        };
        secure_directory(&self.runtime().native_helper, &directory)?;
        self.check_pairing_owner(&directory, sid)?;
        if let Some(sid) = sid {
            fs::write(directory.join(PAIRED_BY_FILE), format!("{sid}\n"))
                .map_err(|_| "Nessie could not remember who started pairing.".to_owned())?;
        }
        self.run_pairing(
            &directory,
            "start",
            vec![
                "--api".to_owned(),
                origin.to_owned(),
                "--pairing-input-stdin".to_owned(),
            ],
            Some(serde_json::json!({ "workspaceRoot": workspace, "replace": replace })),
        )
    }

    fn check_pairing_owner(&self, directory: &Path, sid: Option<&str>) -> Result<(), String> {
        if directory.join(PENDING_FILE).exists() {
            let owner = fs::read_to_string(directory.join(PAIRED_BY_FILE)).unwrap_or_default();
            if sid.is_none() || sid != Some(owner.trim()) {
                return Err("Finish pairing from the Windows account that started it.".to_owned());
            }
        }
        Ok(())
    }

    pub fn pairing_action(
        &mut self,
        action: &str,
        digest: Option<&str>,
        sid: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let directory = self.pairing_directory()?;
        secure_directory(&self.runtime().native_helper, &directory)?;
        self.check_pairing_owner(&directory, sid)?;
        let completing_pending = directory.join(PENDING_FILE).exists();
        let extra = digest
            .map(|value| vec!["--claim-digest".to_owned(), value.to_owned()])
            .unwrap_or_default();
        let result = self.run_pairing(&directory, action, extra, None)?;
        if result.get("status").and_then(serde_json::Value::as_str) == Some("paired") {
            let executor = result
                .get("executorId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Pairing returned no computer.".to_owned())?;
            if directory != self.state_dir(executor)? {
                self.promote(&directory, sid)?;
            }
            if action == "confirm" || completing_pending {
                self.start(executor)?;
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::VerifiedRuntime;

    fn supervisor(root: &Path) -> Supervisor {
        Supervisor::new(
            root.to_owned(),
            VerifiedRuntime {
                root: root.to_owned(),
                node_executable: root.join("node.exe"),
                native_helper: root.join("nessie-executor-native.exe"),
            },
        )
    }

    #[test]
    fn only_known_pairing_error_codes_reach_the_tray() {
        assert!(
            pairing_failure(r#"{"error":{"code":"workspace_cleanup_required"}}"#)
                .starts_with("Remove every local draft")
        );
        for output in [
            r#"{"error":{"code":"unknown","message":"private path"}}"#,
            "private path",
        ] {
            assert_eq!(
                pairing_failure(output),
                "Nessie could not complete pairing. Check your connection and try again."
            );
        }
    }

    #[test]
    fn replacement_recovers_pending_state_after_the_old_binding_was_retired() {
        let root = tempfile::tempdir().unwrap();
        let host = supervisor(root.path());
        let directory = host.state_dir("old-executor").unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(PENDING_FILE), "{}").unwrap();
        assert_eq!(host.pairing_directory().unwrap(), directory);
    }

    #[test]
    fn replacement_pending_state_and_its_old_binding_are_one_pairing() {
        let root = tempfile::tempdir().unwrap();
        let host = supervisor(root.path());
        let directory = host.state_dir("old-executor").unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(PENDING_FILE), "{}").unwrap();
        fs::write(directory.join("executor-state.json"), "{}").unwrap();
        assert_eq!(host.pairing_directory().unwrap(), directory);
    }

    #[test]
    fn a_pending_connection_coexists_with_an_existing_pairing() {
        for pending_is_promoted in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let host = supervisor(root.path());
            let paired = host.state_dir("paired-executor").unwrap();
            fs::create_dir_all(&paired).unwrap();
            fs::write(paired.join("executor-state.json"), "{}").unwrap();
            let pending = if pending_is_promoted {
                host.state_dir("other-executor").unwrap()
            } else {
                pending_root(root.path()).join("machine")
            };
            fs::create_dir_all(&pending).unwrap();
            fs::write(pending.join(PENDING_FILE), "{}").unwrap();
            assert_eq!(host.pairing_directory().unwrap(), pending);
        }
    }

    #[test]
    fn another_windows_account_cannot_confirm_an_open_attempt() {
        let root = tempfile::tempdir().unwrap();
        let host = supervisor(root.path());
        fs::write(root.path().join(PENDING_FILE), "{}").unwrap();
        fs::write(root.path().join(PAIRED_BY_FILE), "S-1-5-21-123\n").unwrap();
        assert!(host
            .check_pairing_owner(root.path(), Some("S-1-5-21-999"))
            .is_err());
        assert!(host.check_pairing_owner(root.path(), None).is_err());
        assert!(host
            .check_pairing_owner(root.path(), Some("S-1-5-21-123"))
            .is_ok());
    }

    #[test]
    fn replacement_pending_state_never_starts_the_old_daemon() {
        let root = tempfile::tempdir().unwrap();
        let mut host = supervisor(root.path());
        let directory = host.state_dir("old-executor").unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(PENDING_FILE), "{}").unwrap();
        fs::write(directory.join("executor-state.json"), "{}").unwrap();
        assert_eq!(
            host.start("old-executor"),
            Err("Finish pairing this computer before starting it.".to_owned())
        );
    }
}
