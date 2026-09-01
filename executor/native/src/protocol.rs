use serde::{Deserialize, Serialize};
use std::io;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_CHANGES: usize = 100;
pub const MAX_PATH_LENGTH: usize = 1024;
pub const MAX_REQUEST_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestEntry {
    pub byte_count: u64,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub base: Option<DigestEntry>,
    pub draft: Option<DigestEntry>,
    pub kind: ChangeKind,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightRequest {
    pub changes: Vec<Change>,
    pub manifest_digest: String,
    pub protocol_version: u8,
    pub run_id: String,
}

/// The approval and fence are server-authored command facts. The native helper
/// records them in its durable journal but deliberately cannot mint or verify
/// either: only the companion can call it after verifying the signed command.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionRequest {
    pub approval_digest: String,
    pub binding_fence: String,
    pub changes: Vec<Change>,
    pub manifest_digest: String,
    pub promotion_id: String,
    pub protocol_version: u8,
    pub run_id: String,
}

impl PromotionRequest {
    pub fn manifest(&self) -> PreflightRequest {
        PreflightRequest {
            changes: self.changes.clone(),
            manifest_digest: self.manifest_digest.clone(),
            protocol_version: self.protocol_version,
            run_id: self.run_id.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightStatus {
    Ready,
    Rejected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionStatus {
    Applied,
    Rejected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightResponse {
    pub code: Option<String>,
    pub manifest_digest: String,
    pub run_id: String,
    pub status: PreflightStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionResponse {
    pub code: Option<String>,
    pub manifest_digest: String,
    pub promotion_id: String,
    pub run_id: String,
    pub status: PromotionStatus,
}

#[derive(Debug)]
pub struct NativeError {
    pub code: &'static str,
}

impl NativeError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl From<io::Error> for NativeError {
    fn from(_: io::Error) -> Self {
        Self::new("EXECUTOR_PROMOTION_IO_FAILURE")
    }
}
