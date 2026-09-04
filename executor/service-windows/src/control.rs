//! One accepted control request, carried out.
//!
//! This is the seam between the pipe (which decides *who* is asking) and the
//! supervisor (which decides *what happens*). Every answer is the full executor
//! list, so the tray refreshes in the same round trip that changed something and
//! never renders a state it inferred rather than read.
//!
//! It is deliberately platform-neutral: the two refusals a person is most likely
//! to meet — an executor this computer has not paired, and a malformed id — are
//! decided here and tested on any host.

use std::{path::PathBuf, sync::Mutex};

use crate::{
    helper::secure_directory,
    protocol::{Command, Response},
    supervisor::Supervisor,
};

/// Whether this service may supervise anything, and why not when it may not.
///
/// A service that could not verify its own release or its packaged runtime keeps
/// **running** and refuses every command in words. Stopping instead would leave
/// a person with a service that is not there and no explanation anywhere: the
/// tray would show only "the service is not running", which is the wrong
/// diagnosis for a tampered runtime and names the wrong remedy.
pub enum Control {
    Refused(String),
    Supervising(Mutex<Supervisor>),
}

impl Control {
    pub fn new(supervisor: Supervisor) -> Self {
        Self::Supervising(Mutex::new(supervisor))
    }

    pub fn supervisor(&self) -> Option<&Mutex<Supervisor>> {
        match self {
            Self::Refused(_) => None,
            Self::Supervising(supervisor) => Some(supervisor),
        }
    }

    /// `client_sid` is the account the pipe read off the connection. It is
    /// recorded when a pairing succeeds, which is what admits that person's
    /// later, unelevated calls.
    pub fn handle(&self, command: Command, client_sid: Option<&str>) -> Response {
        let supervisor = match self {
            Self::Refused(reason) => return Response::error(reason.clone()),
            Self::Supervising(supervisor) => supervisor,
        };
        let Ok(mut supervisor) = supervisor.lock() else {
            return Response::error("The Nessie Executor service is not available.");
        };
        let outcome = match command {
            Command::Status => Ok(()),
            Command::Start { executor_id } => supervisor.start(&executor_id).map(|_| ()),
            Command::Stop { executor_id } => supervisor.stop(&executor_id).map(|_| ()),
            Command::Configure { executor_id, operation_keys } => {
                supervisor.configure(&executor_id, &operation_keys).map(|_| ())
            }
            Command::Pair(pair) => {
                let helper: PathBuf = supervisor.runtime().native_helper.clone();
                supervisor
                    .pair(&pair, client_sid, move |path| secure_directory(&helper, path))
                    .map(|_| ())
            }
        };
        match outcome {
            Ok(()) => Response::Ok { executors: supervisor.statuses() },
            Err(reason) => Response::error(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Control;
    use crate::{manifest::VerifiedRuntime, protocol::{Command, Response}, supervisor::Supervisor};

    /// A runtime that names files which do not exist. Every test below refuses
    /// before anything would be executed, which is the point being asserted.
    fn control(root: &std::path::Path) -> Control {
        Control::new(Supervisor::new(
            root.to_path_buf(),
            VerifiedRuntime {
                native_helper: root.join("nessie-executor-native.exe"),
                node_executable: root.join("node.exe"),
                root: root.to_path_buf(),
            },
        ))
    }

    #[test]
    fn a_computer_with_nothing_paired_answers_with_an_empty_list() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(Command::Status, None),
            Response::Ok { executors: Vec::new() },
        );
    }

    /// Starting an executor this computer has never paired must refuse in words
    /// rather than spawn the packaged CLI to find out.
    #[test]
    fn starting_an_unpaired_executor_is_refused_before_anything_runs() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(
                Command::Start { executor_id: "00000000-0000-4000-8000-000000000001".to_owned() },
                None,
            ),
            Response::error("This executor has not been paired on this computer."),
        );
    }

    #[test]
    fn stopping_something_that_is_not_running_is_not_an_error() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(
            control(directory.path()).handle(
                Command::Stop { executor_id: "00000000-0000-4000-8000-000000000001".to_owned() },
                None,
            ),
            Response::Ok { executors: Vec::new() },
        );
    }

    /// A service that refused to supervise still answers, and answers with the
    /// reason. The tray turns red and says why; a service that had stopped
    /// instead would have the tray reporting the wrong problem entirely.
    #[test]
    fn a_refusing_service_answers_every_command_with_its_reason() {
        let refusal = "Executor controls require a signed, intact Nessie release.";
        let control = Control::Refused(refusal.to_owned());
        for command in [
            Command::Status,
            Command::Start { executor_id: "00000000-0000-4000-8000-000000000001".to_owned() },
            Command::Stop { executor_id: "00000000-0000-4000-8000-000000000001".to_owned() },
        ] {
            assert_eq!(control.handle(command, None), Response::error(refusal));
        }
        assert!(control.supervisor().is_none());
    }
}
