//! The one elevated step in pairing, and the only one.
//!
//! The daemon runs as `NT SERVICE\NessieExecutor`, an account with no profile
//! and no rights anywhere a person keeps their work, so before it can read the
//! chosen workspace somebody with administrative rights has to say so. That is
//! what the UAC prompt during pairing is for, and it is worth saying plainly in
//! the dialog: the tray is granting a service account Modify on one directory
//! the person just chose.
//!
//! The same elevated run records the person's own SID under the service root.
//! The control pipe admits Administrators and recorded accounts, so this is what
//! lets the person's ordinary, unelevated tray start, stop and configure
//! executors afterwards without ever prompting again.

use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};

use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree, ERROR_SUCCESS,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_NAME, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use nessie_windows_common::{sid_to_string, SERVICE_ACCOUNT};

use crate::service_identity::{CONTROL_CLIENTS_DIRECTORY, SERVICE_DIRECTORY_NAME};

/// The command-line switch the elevated instance is relaunched with. It carries
/// a directory the person chose in a native picker and nothing else: no
/// challenge, no key, no executor id ever reaches a command line.
pub const GRANT_SWITCH: &str = "--grant-workspace";

/// Windows' "Modify": read, write, execute and delete, but not the right to
/// re-grant. The service must be able to work in the workspace; it must not be
/// able to hand it to anyone else.
const MODIFY: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// The account running this process, in its string form.
fn current_user_sid_string() -> Result<String, String> {
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("Windows would not report this account.".to_owned());
    }
    let mut needed = 0_u32;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0_u8; needed.max(1) as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut needed,
        )
    };
    let text = if read == 0 {
        None
    } else {
        // The buffer owns the SID, so it is still alive for this call.
        sid_to_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
    };
    unsafe { CloseHandle(token) };
    text.ok_or_else(|| "Windows would not report this account.".to_owned())
}

fn service_root() -> Result<PathBuf, String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "Windows reported no ProgramData directory.".to_owned())?;
    Ok(PathBuf::from(program_data).join(SERVICE_DIRECTORY_NAME))
}

/// Adds the service account to the workspace's existing DACL, inherited by
/// everything under it. The current ACL is read and merged rather than
/// replaced: this directory is the person's own work, and an installer that
/// rewrites its permissions wholesale is how people lose access to their files.
fn grant_service_account(path: &Path) -> Result<(), String> {
    let object = wide_path(path);
    let mut existing: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let read = unsafe {
        GetNamedSecurityInfoW(
            object.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut existing,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if read != ERROR_SUCCESS {
        return Err("Windows would not read the workspace's permissions.".to_owned());
    }
    let mut account = wide(SERVICE_ACCOUNT);
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: MODIFY,
        grfAccessMode: SET_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_NAME,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: account.as_mut_ptr(),
        },
    };
    let mut merged: *mut ACL = std::ptr::null_mut();
    let built = unsafe { SetEntriesInAclW(1, &entry, existing, &mut merged) };
    if built != ERROR_SUCCESS || merged.is_null() {
        unsafe { LocalFree(descriptor as HLOCAL) };
        return Err("Windows would not prepare the workspace's permissions.".to_owned());
    }
    let applied = unsafe {
        SetNamedSecurityInfoW(
            object.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            merged,
            std::ptr::null(),
        )
    };
    unsafe {
        LocalFree(merged as HLOCAL);
        LocalFree(descriptor as HLOCAL);
    }
    if applied == ERROR_SUCCESS {
        Ok(())
    } else {
        Err("Windows would not grant the Nessie Executor service access to that workspace."
            .to_owned())
    }
}

/// The elevated half: grant the workspace, then record this account so the
/// person's ordinary tray is admitted to the control pipe. The `status` call at
/// the end is not a health check — the service builds each pipe instance's DACL
/// as it creates it, so serving one connection is what makes it create the next
/// one with the account just recorded.
pub fn grant_workspace(path: &Path) -> Result<(), String> {
    grant_service_account(path)?;
    let sid = current_user_sid_string()?;
    let directory = service_root()?.join(CONTROL_CLIENTS_DIRECTORY);
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Nessie Executor could not record this account.".to_owned())?;
    std::fs::write(directory.join(&sid), b"")
        .map_err(|_| "Nessie Executor could not record this account.".to_owned())?;
    crate::pipe_client::call(&serde_json::json!({ "command": "status" }))?;
    Ok(())
}

/// The unelevated half: relaunch this executable elevated, with the chosen
/// workspace and nothing else, and wait for it. `ShellExecuteExW` is
/// `ShellExecuteW` plus the process handle, which is what makes waiting
/// possible — pairing must not start before the grant has actually landed.
pub fn request_workspace_grant(workspace: &Path) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Nessie Executor could not locate itself.".to_owned())?;
    let file = wide_path(&executable);
    let verb = wide("runas");
    let parameters = wide(&format!("{GRANT_SWITCH} \"{}\"", workspace.display()));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
        // The overwhelmingly common cause is the person declining the prompt,
        // and that is a decision, not a defect.
        return Err(
            "Granting the Nessie Executor service access to that workspace was cancelled."
                .to_owned(),
        );
    }
    unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
    let mut code = 0_u32;
    let read = unsafe {
        windows_sys::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut code)
    };
    unsafe { CloseHandle(info.hProcess) };
    if read != 0 && code == 0 {
        Ok(())
    } else {
        Err("The Nessie Executor service was not granted access to that workspace.".to_owned())
    }
}
