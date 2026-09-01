//! Whether a prior daemon is still running, asked the Windows way.
//!
//! Unix has `kill(pid, 0)`; Windows has no signals, so liveness is a process
//! handle. `PROCESS_QUERY_LIMITED_INFORMATION` is the narrowest right that
//! answers the question and is granted across integrity levels, so a daemon
//! started by the same person is always visible.

use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub(super) fn process_is_running(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // The process is gone, or is one this session may not open at all —
        // either way it is not a daemon of ours still tearing down guests.
        return false;
    }
    let mut code = 0_u32;
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    // A pid whose exit code cannot be read is treated as alive: refusing a
    // start is recoverable, starting a second daemon over live guests is not.
    read == 0 || code == STILL_ACTIVE as u32
}
