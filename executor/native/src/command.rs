use crate::protocol::{NativeError, MAX_PATH_LENGTH};

/// Every command the helper answers. Parsing is deliberately host-agnostic so
/// the whole table is exercised on any build machine: only the *bodies* behind
/// `secure-directory` and `verify-owner-only` are Windows-only, and only the
/// bodies behind the workspace commands are POSIX-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Create the executor's private state directory if absent and give it an
    /// owner-only, non-inherited DACL.
    SecureDirectory(String),
    /// Prove that a directory's owner and DACL still admit nobody else.
    VerifyOwnerOnly(String),
    WorkspaceApply,
    WorkspacePreflight,
}

/// Absolute on either host shape, decided without asking this host: a Windows
/// path must verify as absolute when the parser's tests run on Linux, and a
/// POSIX path likewise on a Windows build machine.
fn is_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.first() == Some(&b'/') {
        return true;
    }
    if value.starts_with(r"\\") {
        return true;
    }
    matches!(bytes, [drive, b':', separator, ..]
        if drive.is_ascii_alphabetic() && (*separator == b'\\' || *separator == b'/'))
}

/// The state directory is named on argv because the helper has to be able to
/// *create* it — there is no descriptor to inherit for a path that does not
/// exist yet. It is the supervisor's own state root, never a workspace path and
/// never a secret, and the response echoes nothing back.
fn state_path(value: &str) -> Result<String, NativeError> {
    if value.is_empty() || value.len() > MAX_PATH_LENGTH || value.contains('\0') {
        return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
    }
    if !is_absolute_path(value) {
        return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
    }
    Ok(value.to_owned())
}

pub fn parse_command(arguments: &[String]) -> Result<Command, NativeError> {
    match arguments {
        [command] if command == "workspace-preflight" => Ok(Command::WorkspacePreflight),
        [command] if command == "workspace-apply" => Ok(Command::WorkspaceApply),
        [command, path] if command == "secure-directory" => {
            Ok(Command::SecureDirectory(state_path(path)?))
        }
        [command, path] if command == "verify-owner-only" => {
            Ok(Command::VerifyOwnerOnly(state_path(path)?))
        }
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_command, Command};
    use crate::protocol::MAX_PATH_LENGTH;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn parse(values: &[&str]) -> Result<Command, &'static str> {
        parse_command(&arguments(values)).map_err(|error| error.code)
    }

    #[test]
    fn the_workspace_commands_keep_taking_no_arguments() {
        assert_eq!(parse(&["workspace-preflight"]), Ok(Command::WorkspacePreflight));
        assert_eq!(parse(&["workspace-apply"]), Ok(Command::WorkspaceApply));
        assert_eq!(parse(&["workspace-apply", "/state"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&[]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["workspace"]), Err("EXECUTOR_NATIVE_USAGE"));
    }

    #[test]
    fn the_state_commands_take_one_absolute_path_in_either_host_shape() {
        assert_eq!(
            parse(&["secure-directory", r"C:\Users\person\AppData\Local\Nessie\executors\one"]),
            Ok(Command::SecureDirectory(
                r"C:\Users\person\AppData\Local\Nessie\executors\one".to_owned(),
            )),
        );
        assert_eq!(
            parse(&["verify-owner-only", "/home/person/.local/state/nessie-executor/one"]),
            Ok(Command::VerifyOwnerOnly(
                "/home/person/.local/state/nessie-executor/one".to_owned(),
            )),
        );
        assert_eq!(
            parse(&["secure-directory", r"\\?\C:\Nessie\executors\one"]),
            Ok(Command::SecureDirectory(r"\\?\C:\Nessie\executors\one".to_owned())),
        );
        assert_eq!(parse(&["secure-directory", "C:/Nessie/executors/one"]).is_ok(), true);
    }

    #[test]
    fn a_relative_empty_or_oversized_path_is_a_usage_error() {
        assert_eq!(parse(&["secure-directory"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["secure-directory", ""]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["secure-directory", "executors/one"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["verify-owner-only", r"..\executors"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["secure-directory", "C:"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["secure-directory", "/state\0/one"]), Err("EXECUTOR_NATIVE_USAGE"));
        let oversized = format!("/{}", "a".repeat(MAX_PATH_LENGTH));
        assert_eq!(parse(&["secure-directory", &oversized]), Err("EXECUTOR_NATIVE_USAGE"));
    }

    #[test]
    fn a_state_command_never_accepts_a_second_path() {
        assert_eq!(parse(&["secure-directory", "/one", "/two"]), Err("EXECUTOR_NATIVE_USAGE"));
    }
}
