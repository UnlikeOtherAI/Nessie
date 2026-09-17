//! Talking to the service over `\\.\pipe\NessieExecutor`.
//!
//! One request line, one answer line, one connection. The tray keeps nothing
//! and decides nothing: the service owns the executors, their state, and every
//! refusal a person reads.
//!
//! Two Windows errors matter enough to translate, because they are the two a
//! person can actually act on: the pipe is missing when the service is not
//! running, and access is denied when this account has never been admitted —
//! which is what pairing's one elevated step exists to fix.
//!
//! The protocol's answer shapes are portable and tested on any host; the pipe
//! itself lives behind `cfg(windows)` in [`imp`].

use crate::state::ExecutorStatus;

/// Bounded so a service answering nonsense cannot exhaust this process.
const MAX_ANSWER_BYTES: u64 = 1_048_576;

pub const SERVICE_NOT_RUNNING: &str =
    "the service is not running — start Nessie Executor in Services";

pub const NOT_ADMITTED: &str =
    "this account may not control the executor — pair one from this tray to be admitted";

/// The three useful answers the service can give, plus an error it already
/// worded. The tray never sees a path, a key, or a challenge unless it asked
/// for a describe, and even then the answer is the CLI's credential-free
/// projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceResponse {
    Status(Vec<ExecutorStatus>),
    Pair { executor_id: String, fingerprint: String },
    Describe(serde_json::Value),
    Error(String),
}

#[cfg(windows)]
mod imp {
    use std::{
        io::{Read, Write},
        mem::ManuallyDrop,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
        GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    use super::{decode, MAX_ANSWER_BYTES, NOT_ADMITTED, SERVICE_NOT_RUNNING};

    const PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

    /// How long to wait for a free instance, and how many times. The service
    /// serves each connection on its own thread, so a busy pipe is a burst, not
    /// a queue.
    const BUSY_WAIT_MS: u32 = 2_000;

    const BUSY_ATTEMPTS: u32 = 3;

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn open() -> Result<HANDLE, String> {
        let name = wide(PIPE_NAME);
        for _ in 0..BUSY_ATTEMPTS {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                return Ok(handle);
            }
            match unsafe { GetLastError() } {
                ERROR_PIPE_BUSY => {
                    unsafe { WaitNamedPipeW(name.as_ptr(), BUSY_WAIT_MS) };
                }
                ERROR_FILE_NOT_FOUND => return Err(SERVICE_NOT_RUNNING.to_owned()),
                ERROR_ACCESS_DENIED => return Err(NOT_ADMITTED.to_owned()),
                _ => return Err("the service could not be reached".to_owned()),
            }
        }
        Err("the service is busy — try again in a moment".to_owned())
    }

    /// Sends one request and returns the answer it was given. A refusal comes
    /// back as the service's own words, never as a status code the tray would
    /// have to invent a sentence for.
    pub fn call(request: &serde_json::Value) -> Result<super::ServiceResponse, String> {
        let handle = open()?;
        let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as *mut _) });
        let mut line = serde_json::to_string(request)
            .map_err(|_| "the control request could not be prepared".to_owned())?;
        line.push('\n');
        let mut answer = String::new();
        let exchange = (&*file)
            .write_all(line.as_bytes())
            .and_then(|()| (&*file).flush())
            .and_then(|()| (&*file).take(MAX_ANSWER_BYTES).read_to_string(&mut answer));
        unsafe { CloseHandle(handle) };
        exchange.map_err(|_| "the service closed the connection".to_owned())?;
        decode(&answer)
    }
}

#[cfg(windows)]
pub use imp::call;

/// The pipe is a Windows object; on any other host the service is simply not
/// there to answer, and the view says so in the words it would use for a
/// stopped service.
#[cfg(not(windows))]
pub fn call(request: &serde_json::Value) -> Result<ServiceResponse, String> {
    let _ = request;
    Err(SERVICE_NOT_RUNNING.to_owned())
}

/// The recognised answer shapes, and nothing else: an answer this reader does
/// not recognise is a failure, never an empty executor list.
fn decode(answer: &str) -> Result<ServiceResponse, String> {
    let parsed: serde_json::Value = serde_json::from_str(answer.trim())
        .map_err(|_| "the service answered in a shape this tray does not understand".to_owned())?;
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("ok") => {
            let executors = serde_json::from_value(
                parsed.get("executors").cloned().unwrap_or(serde_json::Value::Null),
            )
            .map_err(|_| "the service answered in a shape this tray does not understand".to_owned())?;
            Ok(ServiceResponse::Status(executors))
        }
        Some("pairOk") => {
            let executor_id = parsed
                .get("executorId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "the service answered in a shape this tray does not understand".to_owned())?
                .to_owned();
            let fingerprint = parsed
                .get("fingerprint")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "the service answered in a shape this tray does not understand".to_owned())?
                .to_owned();
            Ok(ServiceResponse::Pair { executor_id, fingerprint })
        }
        Some("describe") => {
            let description = parsed
                .get("description")
                .cloned()
                .ok_or_else(|| "the service answered in a shape this tray does not understand".to_owned())?;
            Ok(ServiceResponse::Describe(description))
        }
        Some("error") => Err(parsed
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the service refused the request")
            .to_owned()),
        _ => Err("the service answered in a shape this tray does not understand".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, ServiceResponse};

    #[test]
    fn an_ok_answer_carries_the_executor_list_verbatim() {
        let response = decode(
            r#"{"status":"ok","executors":[{"daemonStatus":"running","executorId":"a-1","workspaceConfigured":true}]}"#,
        )
        .expect("an ok answer must decode");
        let ServiceResponse::Status(executors) = response else { panic!("expected status response") };
        assert_eq!(executors.len(), 1);
        assert_eq!(executors[0].daemon_status, "running");
        assert_eq!(executors[0].executor_id, "a-1");
    }

    #[test]
    fn a_pair_ok_answer_carries_executor_id_and_fingerprint() {
        let response = decode(
            r#"{"status":"pairOk","executorId":"a-1","fingerprint":"abc123"}"#,
        )
        .expect("pair answer must decode");
        assert_eq!(
            response,
            ServiceResponse::Pair {
                executor_id: "a-1".to_owned(),
                fingerprint: "abc123".to_owned(),
            }
        );
    }

    #[test]
    fn a_describe_answer_carries_the_description_json() {
        let response = decode(r#"{"status":"describe","description":{"executorId":"a-1"}}"#)
            .expect("describe answer must decode");
        let ServiceResponse::Describe(description) = response else { panic!("expected describe response") };
        assert_eq!(description["executorId"], "a-1");
    }

    #[test]
    fn a_refusal_reaches_the_person_in_the_services_own_words() {
        assert_eq!(
            decode(r#"{"status":"error","reason":"This executor has not been paired on this computer."}"#),
            Err("This executor has not been paired on this computer.".to_owned()),
        );
    }

    /// The failure mode worth naming: an unrecognised answer must not read as
    /// "no executors are paired", which would look exactly like a healthy
    /// machine with nothing set up.
    #[test]
    fn an_unrecognised_answer_is_a_failure_and_not_an_empty_list() {
        for answer in ["", "not json", "{}", r#"{"status":"maybe"}"#, r#"{"status":"ok","executors":3}"#] {
            assert!(decode(answer).is_err(), "answer {answer:?} must be a failure");
        }
    }
}
