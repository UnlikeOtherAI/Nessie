mod command;
// The workspace commands act on inherited directory descriptors with `openat`
// and friends, which have no Windows equivalent: the Windows helper exists for
// the two state-security commands, and the parser above still knows all four so
// the argument contract is one table on every host.
#[cfg(unix)]
mod preflight;
#[cfg(unix)]
mod promotion;
#[cfg(unix)]
mod promotion_fs;
mod protocol;
mod state_security;

use command::{parse_command, Command};
use protocol::{
    NativeError, PreflightResponse, PreflightStatus, PromotionResponse, PromotionStatus,
    StateSecurityResponse, StateSecurityStatus,
};
use std::env;

fn respond(response: &PreflightResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

fn respond_promotion(response: &PromotionResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

fn respond_state_security(response: &StateSecurityResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

#[cfg(unix)]
fn run_preflight() -> Result<(), NativeError> {
    let request = preflight::read_request()?;
    preflight::preflight(3, 4, &request)?;
    respond(&PreflightResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        run_id: request.run_id,
        status: PreflightStatus::Ready,
    });
    Ok(())
}

#[cfg(unix)]
fn run_promotion() -> Result<(), NativeError> {
    let request = promotion::read_promotion_request()?;
    promotion::apply(3, 4, &request)?;
    respond_promotion(&PromotionResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        promotion_id: request.promotion_id,
        run_id: request.run_id,
        status: PromotionStatus::Applied,
    });
    Ok(())
}

#[cfg(not(unix))]
fn run_preflight() -> Result<(), NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

#[cfg(not(unix))]
fn run_promotion() -> Result<(), NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

fn run(command: &Command) -> Result<(), NativeError> {
    match command {
        Command::WorkspacePreflight => run_preflight(),
        Command::WorkspaceApply => run_promotion(),
        Command::SecureDirectory(path) => {
            state_security::secure_directory(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::VerifyOwnerOnly(path) => {
            state_security::verify_owner_only(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Verified,
            });
            Ok(())
        }
    }
}

/// A refusal answers in the shape of the command that was asked for, so a
/// caller parses one response type per command and never a foreign one. An
/// unparsable argv keeps answering in the promotion shape, as it always has.
fn reject(command: Option<&Command>, error: &NativeError) {
    match command {
        Some(Command::WorkspacePreflight) => respond(&PreflightResponse {
            code: Some(error.code.to_owned()),
            manifest_digest: String::new(),
            run_id: String::new(),
            status: PreflightStatus::Rejected,
        }),
        Some(Command::SecureDirectory(_)) | Some(Command::VerifyOwnerOnly(_)) => {
            respond_state_security(&StateSecurityResponse {
                code: Some(error.code.to_owned()),
                status: StateSecurityStatus::Rejected,
            })
        }
        Some(Command::WorkspaceApply) | None => respond_promotion(&PromotionResponse {
            code: Some(error.code.to_owned()),
            manifest_digest: String::new(),
            promotion_id: String::new(),
            run_id: String::new(),
            status: PromotionStatus::Rejected,
        }),
    }
}

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let outcome = match parse_command(&arguments) {
        Ok(command) => run(&command).map_err(|error| (Some(command), error)),
        Err(error) => Err((None, error)),
    };
    if let Err((command, error)) = outcome {
        reject(command.as_ref(), &error);
        std::process::exit(1);
    }
}
