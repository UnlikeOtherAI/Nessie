use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};

use super::identity::{
    identity_from_store, record_connection_epoch, MachineIdentity, PlatformMachineIdentityStore,
};

const DIRECT_HOST_READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct DirectHostSupervisor {
    /// A direct host is process-bound. It cannot survive a Desktop exit and
    /// must establish a fresh server lease before it may process anything.
    child: Option<Child>,
    parent_liveness: Option<ChildStdin>,
    host_id: Option<String>,
    organization_id: Option<String>,
}

impl DirectHostSupervisor {
    pub(super) fn start(
        &mut self,
        app: &AppHandle,
        host_id: &str,
        organization_id: &str,
    ) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let store = PlatformMachineIdentityStore::new(app)?;
        let identity = identity_from_store(&store)?
            .ok_or_else(|| "Prepare local Ollama hosting before starting it.".to_owned())?;
        let input = direct_host_configuration(
            &super::configured_api_origin(cfg!(debug_assertions)),
            &identity,
            host_id,
            organization_id,
        )?;
        let serialized = serde_json::to_vec(&input).map_err(|_| {
            "Nessie Desktop could not prepare protected local host material.".to_owned()
        })?;
        let receipt_directory = direct_host_receipt_directory(app)?;
        let mut command = crate::executor_companion::executor_command(app)?;
        command.args(["serve-direct-local-inference", "--config-stdin"]);
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
        command.env(
            "NESSIE_DIRECT_LOCAL_INFERENCE_RECEIPT_DIR",
            receipt_directory,
        );
        let mut child = command.spawn().map_err(|_| {
            "Nessie Desktop could not start its protected local Ollama host.".to_owned()
        })?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            "Nessie Desktop could not provide local host material securely.".to_owned()
        })?;
        if stdin
            .write_all(&serialized)
            .and_then(|_| stdin.write_all(b"\n"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Nessie Desktop could not provide local host material securely.".to_owned(),
            );
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Nessie Desktop could not read local host state.".to_owned())?;
        let next_epoch = match wait_for_direct_host_ready(stdout, identity.connection_epoch) {
            Ok(epoch) => epoch,
            Err(error) => {
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        if let Err(error) = record_connection_epoch(&store, &identity, next_epoch) {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        self.child = Some(child);
        self.parent_liveness = Some(stdin);
        self.host_id = Some(host_id.to_owned());
        self.organization_id = Some(organization_id.to_owned());
        Ok(())
    }

    pub(super) fn stop(&mut self) {
        // Closing stdin is the direct host's cross-platform graceful stop signal.
        // It sends its signed goodbye before returning; Desktop never force-kills a
        // model process and a failed goodbye still expires through the 60s lease.
        self.parent_liveness.take();
        let _ = self.is_running();
    }

    pub(super) fn is_running(&mut self) -> bool {
        let running = matches!(self.child.as_mut().map(Child::try_wait), Some(Ok(None)));
        if !running {
            self.child.take();
            self.parent_liveness.take();
        }
        running
    }

    pub(super) fn host_context(&self) -> Result<(String, String), String> {
        match (self.host_id.clone(), self.organization_id.clone()) {
            (Some(host), Some(organization)) => Ok((host, organization)),
            _ => Err("Nessie Desktop could not verify the local host confirmation.".to_owned()),
        }
    }
}

fn direct_host_configuration(
    api_base_url: &str,
    identity: &MachineIdentity,
    host_id: &str,
    organization_id: &str,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "apiBaseUrl": api_base_url,
        "connectionEpoch": identity.connection_epoch.to_string(),
        "hostId": host_id,
        "machinePrivateKey": identity.private_key_pkcs8_base64url()?,
        "organizationId": organization_id,
        "receiptJournalKey": identity.receipt_journal_key_base64url()?,
    }))
}

fn direct_host_receipt_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| {
            "Nessie Desktop could not resolve protected local inference storage.".to_owned()
        })?
        .join("local-inference");
    std::fs::create_dir_all(&directory).map_err(|_| {
        "Nessie Desktop could not prepare protected local inference storage.".to_owned()
    })?;
    Ok(directory)
}

fn parse_ready_epoch(line: &str, previous_epoch: u64) -> Result<u64, String> {
    if line.len() > 4_096 {
        return Err("Nessie Desktop could not verify local host state.".to_owned());
    }
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("connectionEpoch")?.as_str()?.parse::<u64>().ok())
        .filter(|epoch| *epoch > previous_epoch)
        .ok_or_else(|| "Nessie Desktop could not verify local host state.".to_owned())
}

fn wait_for_direct_host_ready(stdout: ChildStdout, previous_epoch: u64) -> Result<u64, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|_| "Nessie Desktop could not read local host state.".to_owned())?;
            parse_ready_epoch(&line, previous_epoch)
        })();
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(DIRECT_HOST_READY_TIMEOUT)
        .map_err(|_| "Nessie Desktop local host did not become ready in time.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::{direct_host_configuration, parse_ready_epoch};
    use crate::local_inference::identity::{
        identity_from_store, record_connection_epoch, MachineIdentity, MachineIdentityStore,
    };
    use std::sync::Mutex;

    #[derive(Default)]
    struct FixtureStore(Mutex<Option<Vec<u8>>>);

    impl MachineIdentityStore for FixtureStore {
        fn delete(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }

        fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn store(&self, value: &[u8]) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(value.to_vec());
            Ok(())
        }
    }

    #[test]
    fn direct_host_ready_epoch_must_advance() {
        assert_eq!(
            parse_ready_epoch(r#"{"connectionEpoch":"2"}"#, 1).unwrap(),
            2
        );
        assert!(parse_ready_epoch(r#"{"connectionEpoch":"1"}"#, 1).is_err());
        assert!(parse_ready_epoch(r#"{"connectionEpoch":"3"}"#, 3).is_err());
    }

    #[test]
    fn reconnect_persists_epoch_before_the_next_host_config_is_serialized() {
        let store = FixtureStore::default();
        let first = MachineIdentity::new(1, 1);
        record_connection_epoch(&store, &first, 2).unwrap();

        let restarted = identity_from_store(&store).unwrap().unwrap();
        let config =
            direct_host_configuration("http://127.0.0.1:5464", &restarted, "host", "org").unwrap();
        assert_eq!(config["connectionEpoch"], "2");
    }
}
