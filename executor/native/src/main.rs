mod preflight;
mod promotion;
mod promotion_fs;
mod protocol;

use preflight::{preflight, read_request};
use promotion::{apply, read_promotion_request};
use protocol::{
    NativeError, PreflightResponse, PreflightStatus, PromotionResponse, PromotionStatus,
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

fn run_preflight() -> Result<(), NativeError> {
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

fn run_promotion() -> Result<(), NativeError> {
    let request = read_promotion_request()?;
    apply(3, 4, &request)?;
    respond_promotion(&PromotionResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        promotion_id: request.promotion_id,
        run_id: request.run_id,
        status: PromotionStatus::Applied,
    });
    Ok(())
}

fn run() -> Result<(), NativeError> {
    match env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [command] if command == "workspace-preflight" => run_preflight(),
        [command] if command == "workspace-apply" => run_promotion(),
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

fn main() {
    let preflight_command =
        env::args().skip(1).collect::<Vec<_>>().as_slice() == ["workspace-preflight"];
    if let Err(error) = run() {
        if preflight_command {
            respond(&PreflightResponse {
                code: Some(error.code.to_owned()),
                manifest_digest: String::new(),
                run_id: String::new(),
                status: PreflightStatus::Rejected,
            });
        } else {
            respond_promotion(&PromotionResponse {
                code: Some(error.code.to_owned()),
                manifest_digest: String::new(),
                promotion_id: String::new(),
                run_id: String::new(),
                status: PromotionStatus::Rejected,
            });
        }
        std::process::exit(1);
    }
}
