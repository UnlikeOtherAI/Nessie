//! Commands reachable only from the bundled, local executor console.
use tauri::AppHandle;
use crate::pipe_client::{call, ServiceResponse};

fn describe(executor_id: &str) -> Result<serde_json::Value, String> {
    match call(&serde_json::json!({ "command": "describe", "executorId": executor_id }))? {
        ServiceResponse::Describe(value) => Ok(value),
        _ => Err("The executor could not describe this connection.".into()),
    }
}

#[tauri::command]
pub async fn executor_console_describe(executor_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || describe(&executor_id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn executor_configure(
    _app: AppHandle, executor_id: String, configuration_input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = describe(&executor_id)?;
        // Only legacy service connections need an explicit service-account ACL.
        if !crate::user_connections::owns(&executor_id) {
        if configuration_input.get("terminalProgram").is_some() {
            return Err("Interactive programs need a user-session connection. Add a team in this app first.".into());
        }
        if let Some(folders) = configuration_input.get("workspaceFolders").and_then(|v| v.as_array()) {
            for folder in folders {
                if let Some(path) = folder.get("path").and_then(|v| v.as_str()) {
                    let existed = current["reach"]["folders"].as_array().is_some_and(|old| {
                        old.iter().any(|entry| entry["path"].as_str() == Some(path))
                    });
                    if !existed { crate::grant::request_workspace_grant(std::path::Path::new(path))?; }
                }
            }
        }
        }
        call(&serde_json::json!({ "command": "configureInput", "executorId": executor_id,
            "configurationInput": configuration_input }))?;
        describe(&executor_id)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn executor_autostart() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "enabled": autostart::enabled()?,
        "note": "This app and its team connections start when you sign in. Existing service connections run separately." }))
}

#[tauri::command]
pub fn executor_set_autostart(enabled: bool) -> Result<(), String> { autostart::set(enabled) }

#[tauri::command]
pub fn executor_copy_code(code: String) -> Result<(), String> {
    if code.len() != 8 || !code.bytes().all(|digit| digit.is_ascii_digit()) { return Err("Invalid pairing code.".into()); }
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        let mut process = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"])
            .creation_flags(0x08000000).stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|_| "Could not copy the code.".to_owned())?;
        process.stdin.take().ok_or("Could not copy the code.")?.write_all(code.as_bytes()).map_err(|e| e.to_string())?;
        if !process.wait().map_err(|e| e.to_string())?.success() { return Err("Could not copy the code.".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("This is the Windows executor console.".into())
}

#[cfg(windows)]
mod autostart {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, REG_SZ, RRF_RT_REG_SZ};
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const NAME: &str = "NessieExecutorTray";
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn launch() -> Result<String, String> {
        Ok(format!("\"{}\"", std::env::current_exe().map_err(|e| e.to_string())?.display()))
    }
    pub fn enabled() -> Result<bool, String> {
        let mut size = 0;
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide(NAME).as_ptr(),
            RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
        if status == 2 { return Ok(false); }
        if status != 0 { return Err("Could not read the Windows login setting.".into()); }
        let mut buffer = vec![0u16; (size as usize / 2) + 1];
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide(NAME).as_ptr(),
            RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) };
        if status != 0 { return Err("Could not read the Windows login setting.".into()); }
        Ok(String::from_utf16_lossy(&buffer).trim_end_matches('\0') == launch()?)
    }
    pub fn set(enabled: bool) -> Result<(), String> {
        let status = if enabled {
            let value = wide(&launch()?);
            unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide(NAME).as_ptr(), REG_SZ,
                value.as_ptr().cast(), (value.len() * 2) as u32) }
        } else {
            unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(KEY).as_ptr(), wide(NAME).as_ptr()) }
        };
        if status == 0 || (!enabled && status == 2) { Ok(()) }
        else { Err("Could not change the Windows login setting.".into()) }
    }
}

#[cfg(not(windows))]
mod autostart {
    pub fn enabled() -> Result<bool, String> { Err("Windows only.".into()) }
    pub fn set(_: bool) -> Result<(), String> { Err("Windows only.".into()) }
}
