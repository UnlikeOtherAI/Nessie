mod preflight;
mod protocol;

use preflight::{preflight, read_request};
use protocol::{NativeError, PreflightResponse, PreflightStatus};
use std::env;

fn respond(response: &PreflightResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

fn run() -> Result<(), NativeError> {
    if env::args().skip(1).collect::<Vec<_>>().as_slice() != ["workspace-preflight"] {
        return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
    }
    let request = read_request()?;
    preflight(3, 4, &request)?;
    respond(&PreflightResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        run_id: request.run_id,
        status: PreflightStatus::Ready,
    });
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        respond(&PreflightResponse {
            code: Some(error.code.to_owned()),
            manifest_digest: String::new(),
            run_id: String::new(),
            status: PreflightStatus::Rejected,
        });
        std::process::exit(1);
    }
}
