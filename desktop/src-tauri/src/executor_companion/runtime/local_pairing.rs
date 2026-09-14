use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::Deserialize;

pub(super) const EXECUTOR_STATE_FILE: &str = "executor-state.json";
const DEEPTEST_SOURCE_GRANT_FILE: &str = "deeptest-source-grant.json";
const STATE_MUTATION_LOCK_FILE: &str = "executor-state-mutation.lock";

pub(crate) fn has_deeptest_source_grant(state_dir: &Path) -> bool {
    fs::symlink_metadata(state_dir.join(DEEPTEST_SOURCE_GRANT_FILE))
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStateSummary {
    descriptor: LocalDescriptorSummary,
    workspace_root: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalDescriptorSummary {
    operation_keys: Vec<String>,
}

fn private_workspace_label(workspace: &Path) -> String {
    workspace
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Selected filesystem root")
        .to_owned()
}

pub(crate) fn local_policy_summary(state_dir: &Path) -> Result<(String, Vec<String>), String> {
    let path = state_dir.join(EXECUTOR_STATE_FILE);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Nessie Desktop could not read this executor's local policy.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Nessie Desktop executor state must be an ordinary file.".to_owned());
    }
    let state: LocalStateSummary =
        serde_json::from_slice(&fs::read(path).map_err(|_| {
            "Nessie Desktop could not read this executor's local policy.".to_owned()
        })?)
        .map_err(|_| "Nessie Desktop executor state is malformed.".to_owned())?;
    Ok((
        private_workspace_label(&state.workspace_root),
        state.descriptor.operation_keys,
    ))
}

pub(crate) fn forget_local_pairing(state_dir: &Path) -> Result<(), String> {
    let lock_path = state_dir.join(STATE_MUTATION_LOCK_FILE);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut lock = options.open(&lock_path).map_err(|_| {
        "Nessie Desktop cannot forget this executor while its local state is being updated."
            .to_owned()
    })?;
    let result = (|| {
        writeln!(lock, "{}", std::process::id())
            .and_then(|_| lock.sync_all())
            .map_err(|_| "Nessie Desktop could not secure the executor state update.".to_owned())?;
        let grant_file = state_dir.join(DEEPTEST_SOURCE_GRANT_FILE);
        let removed_grant = match fs::symlink_metadata(&grant_file) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(
                        "Nessie Desktop DeepTest source grant must be an ordinary file.".to_owned(),
                    );
                }
                fs::remove_file(&grant_file).map_err(|_| {
                    "Nessie Desktop could not revoke the DeepTest source grant.".to_owned()
                })?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => {
                return Err("Nessie Desktop could not verify the DeepTest source grant.".to_owned())
            }
        };
        let state_file = state_dir.join(EXECUTOR_STATE_FILE);
        let metadata = match fs::symlink_metadata(&state_file) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && removed_grant => None,
            Err(_) => {
                return Err(
                    "This executor has not been paired on this Nessie Desktop device.".to_owned(),
                )
            }
        };
        if metadata
            .as_ref()
            .is_some_and(|entry| entry.file_type().is_symlink() || !entry.is_file())
        {
            return Err("Nessie Desktop executor state must be an ordinary file.".to_owned());
        }
        let runtime_directory = state_dir.join("runtime");
        if let Ok(metadata) = fs::symlink_metadata(&runtime_directory) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(
                    "Nessie Desktop executor runtime state must be an ordinary directory."
                        .to_owned(),
                );
            }
            fs::remove_dir_all(&runtime_directory)
                .map_err(|_| "Nessie Desktop could not remove local executor drafts.".to_owned())?;
        }
        if metadata.is_some() {
            fs::remove_file(state_file).map_err(|_| {
                "Nessie Desktop could not forget the local executor pairing.".to_owned()
            })?;
        }
        Ok(())
    })();
    drop(lock);
    let _ = fs::remove_file(lock_path);
    result?;
    let _ = fs::remove_dir(state_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        forget_local_pairing, has_deeptest_source_grant, private_workspace_label,
        DEEPTEST_SOURCE_GRANT_FILE, EXECUTOR_STATE_FILE, STATE_MUTATION_LOCK_FILE,
    };
    use std::fs;

    fn state_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nessie-local-pairing-{}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("the test state directory must be creatable");
        path
    }

    #[test]
    fn forget_removes_the_source_grant_and_paired_state() {
        let directory = state_dir("forget");
        fs::write(directory.join(EXECUTOR_STATE_FILE), "paired").expect("state");
        fs::write(directory.join(DEEPTEST_SOURCE_GRANT_FILE), "grant").expect("grant");

        forget_local_pairing(&directory).expect("forget must revoke both local files");

        assert!(!directory.join(EXECUTOR_STATE_FILE).exists());
        assert!(!directory.join(DEEPTEST_SOURCE_GRANT_FILE).exists());
        assert!(!directory.join(STATE_MUTATION_LOCK_FILE).exists());
        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn an_active_writer_blocks_forget_without_revoking_files() {
        let directory = state_dir("locked");
        let state_file = directory.join(EXECUTOR_STATE_FILE);
        let grant_file = directory.join(DEEPTEST_SOURCE_GRANT_FILE);
        fs::write(&state_file, "paired").expect("state");
        fs::write(&grant_file, "grant").expect("grant");
        fs::write(directory.join(STATE_MUTATION_LOCK_FILE), "writer").expect("lock");

        assert!(forget_local_pairing(&directory).is_err());
        assert!(state_file.exists());
        assert!(grant_file.exists());
        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn forget_cleans_up_a_grant_even_when_paired_state_is_missing() {
        let directory = state_dir("missing-state");
        let grant_file = directory.join(DEEPTEST_SOURCE_GRANT_FILE);
        let runtime_directory = directory.join("runtime");
        fs::create_dir(&runtime_directory).expect("runtime directory");
        fs::write(runtime_directory.join("draft"), "local draft").expect("draft");
        fs::write(&grant_file, "grant").expect("grant");

        assert!(has_deeptest_source_grant(&directory));
        forget_local_pairing(&directory).expect("the orphan grant must remain revocable");
        assert!(!grant_file.exists());
        assert!(!runtime_directory.exists());
        assert!(!directory.join(STATE_MUTATION_LOCK_FILE).exists());
        fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn workspace_label_exposes_only_the_selected_leaf() {
        let workspace = std::path::Path::new("/Users/person/Private client");
        assert_eq!(private_workspace_label(workspace), "Private client");
        assert!(!private_workspace_label(workspace).contains("person"));
    }
}
