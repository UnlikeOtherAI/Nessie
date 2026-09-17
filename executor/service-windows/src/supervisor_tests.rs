use crate::supervisor::{
    configure_arguments, configure_input_arguments, describe_arguments, pair_arguments,
    parse_fingerprint, serve_arguments,
};
use crate::{manifest::VerifiedRuntime, paths::EXECUTOR_STATE_FILE, supervisor::Supervisor};
use std::{fs, path::Path};

const EXECUTOR_ID: &str = "00000000-0000-4000-8000-000000000001";

fn paired_supervisor(root: &Path) -> Supervisor {
    let state = root.join("executors").join(EXECUTOR_ID);
    fs::create_dir_all(&state).expect("state directory");
    fs::write(state.join(EXECUTOR_STATE_FILE), b"{}").expect("paired state");
    Supervisor::new(
        root.to_path_buf(),
        VerifiedRuntime {
            native_helper: root.join("native-helper"),
            node_executable: root.join("missing-node"),
            root: root.to_path_buf(),
        },
    )
}

#[cfg(windows)]
fn scripted_supervisor(root: &Path, serve: &str) -> Supervisor {
    let mut supervisor = paired_supervisor(root);
    let script = root.join("fake-node.cmd");
    fs::write(
        &script,
        format!(
            "@echo off\r\nif \"%2\"==\"connect\" exit /b 0\r\nif \"%2\"==\"serve\" {serve}\r\n"
        ),
    )
    .expect("script");
    supervisor.runtime.node_executable = script;
    supervisor
}

#[test]
fn pairing_arguments_keep_sensitive_input_off_the_process_list() {
    let arguments = pair_arguments(
        "https://api.nessie.works",
        "00000000-0000-4000-8000-000000000001",
        Path::new("/service/state"),
    );
    assert!(arguments.contains(&"--pair-input-stdin".to_owned()));
    assert!(!arguments
        .iter()
        .any(|argument| argument.contains("challenge-value")));
    assert!(!arguments
        .iter()
        .any(|argument| argument.contains("workspace")));
}

#[test]
fn the_daemon_is_started_with_the_liveness_pipe_that_stops_it() {
    // Closing this pipe is the whole Windows stop path; a `serve` without
    // the flag would have to be terminated instead.
    assert_eq!(
        serve_arguments(Path::new("/service/state")),
        vec![
            "serve",
            "--parent-liveness-stdin",
            "--state-dir",
            "/service/state"
        ],
    );
}

#[test]
fn a_policy_is_passed_as_the_canonical_comma_separated_list() {
    assert_eq!(
        configure_arguments(
            Path::new("/service/state"),
            &["file.read".to_owned(), "sandbox.stop".to_owned()],
        ),
        vec![
            "configure",
            "--state-dir",
            "/service/state",
            "--operations",
            "file.read,sandbox.stop"
        ],
    );
}

#[test]
fn configuration_input_uses_stdin_and_keeps_the_payload_off_argv() {
    assert_eq!(
        configure_input_arguments(Path::new("/service/state")),
        vec![
            "configure",
            "--configuration-input-stdin",
            "--state-dir",
            "/service/state"
        ],
    );
}

#[test]
fn describe_asks_for_the_credential_free_projection() {
    assert_eq!(
        describe_arguments(Path::new("/service/state")),
        vec!["describe", "--state-dir", "/service/state"],
    );
}

#[test]
fn fingerprint_is_read_from_the_cli_success_line() {
    assert_eq!(
        parse_fingerprint(
            "Pairing request submitted. Confirm fingerprint abc123 in Nessie, then run connect.\n"
        ),
        Some("abc123".to_owned()),
    );
    assert_eq!(parse_fingerprint(""), None);
    assert_eq!(parse_fingerprint("no fingerprint here"), None);
}

#[test]
fn a_requested_start_is_visible_while_recovery_retries_and_stop_cancels_it() {
    let directory = tempfile::tempdir().expect("temporary state");
    let mut supervisor = paired_supervisor(directory.path());
    assert_eq!(supervisor.start(EXECUTOR_ID), Ok("starting".to_owned()));
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("starting".to_owned()));
    // The packaged command cannot spawn in this portable test, which is a
    // deterministic stand-in for a boot-time remote outage. It remains
    // desired until a person explicitly stops it.
    assert_eq!(supervisor.recover_due().len(), 1);
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("starting".to_owned()));
    assert_eq!(supervisor.stop(EXECUTOR_ID), Ok("stopped".to_owned()));
    assert!(supervisor.recover_due().is_empty());
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("stopped".to_owned()));
}

#[cfg(windows)]
#[test]
fn a_real_connect_child_is_polled_then_a_crash_is_backed_off_without_status_consuming_it() {
    let directory = tempfile::tempdir().expect("temporary state");
    let mut supervisor = scripted_supervisor(directory.path(), "exit /b 0");
    supervisor.start(EXECUTOR_ID).expect("queue start");
    supervisor.recover_due(); // spawn connect without holding a network wait
    std::thread::sleep(std::time::Duration::from_millis(25));
    supervisor.recover_due(); // connect success, spawn serve
    std::thread::sleep(std::time::Duration::from_millis(25));
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("starting".to_owned()));
    supervisor.recover_due(); // owns the crash observation and schedules backoff
    assert!(
        supervisor.recover_due().is_empty(),
        "crash must not relaunch immediately"
    );
    supervisor.stop(EXECUTOR_ID).expect("stop cancels retries");
    assert!(supervisor.recover_due().is_empty());
}
