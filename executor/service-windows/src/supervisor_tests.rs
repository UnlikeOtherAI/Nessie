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
fn scripted_supervisor(root: &Path) -> Supervisor {
    let mut supervisor = paired_supervisor(root);
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is required for Windows executor lifecycle tests");
    assert!(node.status.success(), "Node is required for Windows executor lifecycle tests");
    let script = root.join("nessie-executor.cjs");
    fs::write(
        &script,
        "const fs=require('fs');const a=process.argv.slice(2);const d=a[a.indexOf('--state-dir')+1];if(a[0]==='connect'){fs.writeFileSync(d+'/connect.marker','');process.exit(fs.existsSync(d+'/fail.connect')?1:0)}fs.writeFileSync(d+'/serve.marker','');setInterval(()=>{if(fs.existsSync(d+'/crash.marker'))process.exit(0)},5);process.stdin.on('end',()=>process.exit(0));",
    )
    .expect("script");
    supervisor.runtime.node_executable = std::path::PathBuf::from(String::from_utf8(node.stdout).expect("Node path").trim());
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
fn until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture phase did not arrive"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
#[test]
fn recovery_observes_connect_serve_crash_backoff_stop_and_shutdown() {
    let directory = tempfile::tempdir().expect("temporary state");
    let state = directory.path().join("executors").join(EXECUTOR_ID);
    let mut supervisor = scripted_supervisor(directory.path());
    supervisor.start(EXECUTOR_ID).expect("queue start");
    supervisor.recover_due();
    until(|| {
        supervisor.recover_due();
        state.join("connect.marker").exists()
    });
    until(|| {
        supervisor.recover_due();
        state.join("serve.marker").exists()
    });
    assert_eq!(supervisor.status(EXECUTOR_ID), Ok("running".to_owned()));
    fs::write(state.join("crash.marker"), b"").expect("request crash");
    until(|| {
        supervisor.recover_due();
        supervisor.retry_after.contains_key(EXECUTOR_ID)
    });
    let delay = supervisor.retry_delay[EXECUTOR_ID];
    assert!(delay >= std::time::Duration::from_secs(10));
    assert!(
        supervisor.recover_due().is_empty(),
        "crash must not relaunch immediately"
    );
    supervisor.stop(EXECUTOR_ID).expect("stop cancels retries");
    assert!(supervisor.recover_due().is_empty());
    supervisor.request_shutdown();
    assert!(supervisor.desired.is_empty() && supervisor.connections.is_empty());
}
