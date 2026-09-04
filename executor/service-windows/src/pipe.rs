//! The control channel: `\\.\pipe\NessieExecutor`, one JSON object per line.
//!
//! Each accepted connection is served on its own short-lived thread, and a fresh
//! instance is created immediately, so a client that connects and then says
//! nothing cannot wedge the service or lock out the tray. Every instance is
//! created with a descriptor built from the accounts recorded *at that moment*,
//! which is how an elevated grant takes effect without restarting the service.

use std::{
    io::{BufRead, BufReader, Read, Write},
    mem::ManuallyDrop,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use crate::{
    control::Control,
    log::log_line,
    paths::control_client_sids,
    protocol::{parse_request, Response, MAX_REQUEST_BYTES},
    security::{connected_client_sid_string, current_user_sid_string, PipeSecurity, CLIENT_ACCESS},
};

pub const PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

/// Big enough for the largest request the protocol accepts plus its answer, so
/// a control call never blocks on the transport itself.
const PIPE_BUFFER_BYTES: u32 = 128 * 1024;

/// The default time a client waits for an instance, in milliseconds. Only
/// applies to a client that asks Windows to wait.
const PIPE_DEFAULT_TIMEOUT_MS: u32 = 5_000;

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// The accounts every instance admits: those recorded under the service root,
/// plus the service's own account so the stop path can unblock its own accept.
fn admitted_sids(root: &Path) -> Vec<String> {
    let mut sids = control_client_sids(root);
    if let Ok(own) = current_user_sid_string() {
        sids.push(own);
    }
    sids.sort();
    sids.dedup();
    sids
}

fn create_instance(root: &Path) -> Result<HANDLE, String> {
    let mut security = PipeSecurity::new(&admitted_sids(root))?;
    let attributes = security.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            wide(PIPE_NAME).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            // Byte mode with blocking reads, and never over the network: a DACL
            // alone would still admit a domain account remotely.
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            PIPE_DEFAULT_TIMEOUT_MS,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err("Nessie Executor could not open its control channel.".to_owned());
    }
    Ok(handle)
}

/// Reads one request line and writes one answer. The handle is closed here, and
/// only here: `ManuallyDrop` keeps the `File` wrapper from closing it early,
/// because a pipe must be flushed and disconnected first or the client can lose
/// the answer it is still reading.
fn serve_connection(handle: HANDLE, control: &Control) {
    let client_sid = connected_client_sid_string(handle);
    let file = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle as *mut _) });
    let mut line = String::new();
    let response = {
        let mut reader = BufReader::new((&*file).take(MAX_REQUEST_BYTES as u64 + 1));
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(match parse_request(line.trim_end_matches(['\r', '\n'])) {
                Ok(command) => control.handle(command, client_sid.as_deref()),
                Err(reason) => Response::error(reason),
            }),
        }
    };
    if let Some(response) = response {
        let mut writer = &*file;
        let _ = writer.write_all(response.encode().as_bytes());
        let _ = writer.flush();
    }
    unsafe {
        FlushFileBuffers(handle);
        DisconnectNamedPipe(handle);
        CloseHandle(handle);
    }
}

/// Unblocks a pending `ConnectNamedPipe` by connecting to it. The service's own
/// account is admitted for exactly this, so a stop never waits on whether anyone
/// happens to call.
pub fn poke() {
    let handle = unsafe {
        CreateFileW(
            wide(PIPE_NAME).as_ptr(),
            // Use exactly the rights the pipe DACL grants. `GENERIC_WRITE`
            // expands to `FILE_APPEND_DATA`, which means
            // `FILE_CREATE_PIPE_INSTANCE` for a named pipe and is deliberately
            // denied. Requesting it here made the service deny its own stop
            // wake-up and left MSI uninstall waiting on `ConnectNamedPipe`.
            CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
        unsafe { CloseHandle(handle) };
    }
}

/// Accepts control connections until `shutdown` is set. Returns only when it is:
/// the caller pokes the pipe to wake this loop.
pub fn serve(root: PathBuf, control: Arc<Control>, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        let handle = match create_instance(&root) {
            Ok(handle) => handle,
            Err(reason) => {
                log_line(&root, &reason);
                return;
            }
        };
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if shutdown.load(Ordering::SeqCst) || !connected {
            unsafe {
                DisconnectNamedPipe(handle);
                CloseHandle(handle);
            }
            continue;
        }
        let served = Arc::clone(&control);
        // `HANDLE` is a raw pointer and therefore not `Send`; it is a kernel
        // handle valid in every thread of this process, and exactly one thread
        // owns it from here to its `CloseHandle`.
        let owned = handle as usize;
        std::thread::spawn(move || serve_connection(owned as HANDLE, &served));
    }
}
