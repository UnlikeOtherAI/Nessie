//! The verified packaged CLI, running as the person who opened the executor.
use std::{
    io::{Read, Write}, path::PathBuf, process::{Child, Command, Stdio},
    thread, time::{Duration, Instant},
};
use nessie_windows_common::runtime::verify_packaged_runtime;

pub fn command() -> Result<Command, String> {
    #[cfg(all(windows, not(debug_assertions)))]
    nessie_windows_provenance::require_release_signature(
        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT"),
    )?;
    let root = std::env::current_exe().ok().and_then(|file| file.parent().map(PathBuf::from))
        .ok_or("Could not locate the packaged executor.")?;
    let runtime = verify_packaged_runtime(&root)?;
    let mut command = Command::new(&runtime.node_executable);
    command.arg(runtime.bundle())
        .env("NESSIE_EXECUTOR_PACKAGED_CLI", "1")
        .env("NESSIE_EXECUTOR_SUPERVISOR", "desktop")
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if cfg!(debug_assertions) { command.env("NESSIE_EXECUTOR_ALLOW_LOCAL_API", "1"); }
    else { command.env_remove("NESSIE_EXECUTOR_ALLOW_LOCAL_API"); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub fn wait(child: &mut Child, duration: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + duration;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() { Ok(true) }
                else { Err("The local executor refused the request. Check its configuration and server connection.".into()) };
        }
        if Instant::now() >= deadline { return Ok(false); }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Only credential-free JSON projections are read. Stderr and daemon output are never retained.
pub fn run(arguments: &[String], input: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut command = command()?;
    command.args(arguments).stdout(Stdio::piped());
    if input.is_some() { command.stdin(Stdio::piped()); }
    let mut child = command.spawn().map_err(|_| "Could not start the local executor.")?;
    let output = child.stdout.take().ok_or("Could not read the local executor.")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(1_048_577).read_to_end(&mut bytes).map(|_| bytes)
    });
    if let Some(input) = input {
        let bytes = serde_json::to_vec(input).map_err(|error| error.to_string())?;
        let mut pipe = child.stdin.take().ok_or("Could not provide local settings.")?;
        pipe.write_all(&bytes).map_err(|_| "Could not provide local settings.")?;
    }
    match wait(&mut child, Duration::from_secs(120)) {
        Ok(true) => {}
        outcome => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(outcome.err().unwrap_or("The local executor request timed out.".into()));
        }
    }
    let bytes = reader.join().map_err(|_| "Could not read the local executor.")?
        .map_err(|_| "Could not read the local executor.")?;
    if bytes.len() > 1_048_576 { return Err("The executor response was too large.".into()); }
    // connect/configure print human-readable acknowledgements; only their success matters.
    if !matches!(arguments.first().map(String::as_str),
        Some("describe" | "pairing-start" | "pairing-status" | "pairing-confirm" | "pairing-cancel")) {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| "The local executor returned an invalid response.".into())
}
