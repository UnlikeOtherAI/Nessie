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

use std::{
    io::{Read, Write},
    mem::ManuallyDrop,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, HANDLE,
    INVALID_HANDLE_VALUE, GENERIC_READ, GENERIC_WRITE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

use crate::state::ExecutorStatus;

const PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

/// How long to wait for a free instance, and how many times. The service serves
/// each connection on its own thread, so a busy pipe is a burst, not a queue.
const BUSY_WAIT_MS: u32 = 2_000;

const BUSY_ATTEMPTS: u32 = 3;

/// Bounded so a service answering nonsense cannot exhaust this process.
const MAX_ANSWER_BYTES: u64 = 1_048_576;

pub const SERVICE_NOT_RUNNING: &str =
    "the service is not running — start Nessie Executor in Services";

pub const NOT_ADMITTED: &str =
    "this account may not control the executor — pair one from this tray to be admitted";

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

/// Sends one request and returns the executor list it answered with. A refusal
/// comes back as the service's own words, never as a status code the tray would
/// have to invent a sentence for.
pub fn call(request: &serde_json::Value) -> Result<Vec<ExecutorStatus>, String> {
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

/// The two shapes the protocol defines, and nothing else: an answer this reader
/// does not recognise is a failure, never an empty executor list.
fn decode(answer: &str) -> Result<Vec<ExecutorStatus>, String> {
    let parsed: serde_json::Value = serde_json::from_str(answer.trim())
        .map_err(|_| "the service answered in a shape this tray does not understand".to_owned())?;
    match parsed.get("status").and_then(serde_json::Value::as_str) {
        Some("ok") => serde_json::from_value(
            parsed.get("executors").cloned().unwrap_or(serde_json::Value::Null),
        )
        .map_err(|_| "the service answered in a shape this tray does not understand".to_owned()),
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
    use super::decode;

    #[test]
    fn an_answer_carries_the_executor_list_verbatim() {
        let executors = decode(
            r#"{"status":"ok","executors":[{"daemonStatus":"running","executorId":"a-1","workspaceConfigured":true}]}"#,
        )
        .expect("an ok answer must decode");
        assert_eq!(executors.len(), 1);
        assert_eq!(executors[0].daemon_status, "running");
        assert_eq!(executors[0].executor_id, "a-1");
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
