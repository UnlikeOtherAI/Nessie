//! A user-owned key must not become an invisible second pairing when the
//! person opens the standalone tray. The owning application retires that key.
use std::{fs, io::ErrorKind, path::Path};
use tauri::Manager;

pub fn require_no_user_pairing(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .data_dir()
        .map_err(|_| "Nessie could not check this computer's existing connection.".to_owned())?
        .join("com.unlikeotherai.nessie.desktop")
        .join("executors");
    if contains_pairing(&root)? {
        return Err("This computer already has a pairing managed by Nessie Desktop. Its existing connection must be closed before pairing here.".to_owned());
    }
    let cli_root = app
        .path()
        .home_dir()
        .map_err(|_| "Nessie could not check this computer's existing connection.".to_owned())?
        .join(".local")
        .join("state")
        .join("nessie-executor");
    if contains_pairing(&cli_root)? {
        return Err("This computer already has a pairing managed from the command line. Close that pairing before pairing with Nessie Executor.".to_owned());
    }
    Ok(())
}

fn contains_pairing(root: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(_) => {
            return Err("Nessie could not check this computer's existing connection.".to_owned())
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Nessie could not verify this computer's existing connection.".to_owned());
    }
    let entries = fs::read_dir(root)
        .map_err(|_| "Nessie could not check this computer's existing connection.".to_owned())?;
    for (index, entry) in entries.enumerate() {
        if index >= 128 {
            return Err("Review this computer's existing Nessie connections first.".to_owned());
        }
        let entry =
            entry.map_err(|_| "Nessie could not check an existing connection.".to_owned())?;
        let kind = entry
            .file_type()
            .map_err(|_| "Nessie could not verify an existing connection.".to_owned())?;
        if kind.is_symlink() {
            return Err("Nessie could not verify an existing connection.".to_owned());
        }
        if !kind.is_dir() {
            continue;
        }
        for name in ["executor-state.json", "executor-pairing-code.json"] {
            match fs::symlink_metadata(entry.path().join(name)) {
                Ok(_) => return Ok(true),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(_) => return Err("Nessie could not check an existing connection.".to_owned()),
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::contains_pairing;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn detects_only_known_pairing_files_in_the_desktop_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "nessie-desktop-pairing-{}-{unique}",
            std::process::id()
        ));
        assert!(!contains_pairing(&root).unwrap());
        fs::create_dir_all(root.join("machine")).unwrap();
        assert!(!contains_pairing(&root).unwrap());
        fs::write(root.join("machine").join("executor-state.json"), b"{}").unwrap();
        assert!(contains_pairing(&root).unwrap());
        fs::remove_file(root.join("machine").join("executor-state.json")).unwrap();
        fs::remove_dir(root.join("machine")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
