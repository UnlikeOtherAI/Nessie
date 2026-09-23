use crate::protocol::{NativeError, MAX_PATH_LENGTH};

/// The most arguments `job-run` passes on, and the longest one. Windows caps a
/// whole command line at 32 767 UTF-16 units, so neither limit is reachable by
/// a command that could start; they only keep a malformed argv from being
/// copied around before `CreateProcessW` refuses it.
pub const MAX_JOB_ARGUMENTS: usize = 256;
pub const MAX_JOB_ARGUMENT_LENGTH: usize = 32_767;

/// Every command the helper answers. Parsing is deliberately host-agnostic so
/// the whole table is exercised on any build machine: only the *bodies* behind
/// `secure-directory`, `verify-owner-only` and `job-run` are Windows-only, and
/// only the bodies behind the workspace commands are POSIX-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Run one program — a coding agent — inside a Job Object that kills the
    /// whole tree when the helper exits, passing stdio through and exiting
    /// with the program's own code. The argv after `--` is the program and its
    /// arguments, exactly as given.
    JobRun(Vec<String>),
    /// Create the executor's private state directory if absent and give it an
    /// owner-only, non-inherited DACL.
    SecureDirectory(String),
    /// Establish the standalone service root before the service starts. Its
    /// owner is the virtual service account, not Windows Installer's SYSTEM.
    SecureServiceDirectory(String),
    /// Prove that a directory's owner and DACL still admit nobody else.
    VerifyOwnerOnly(String),
    /// Prove an individual private file has not overridden its directory DACL.
    VerifyOwnerOnlyFile(String),
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

/// The program and its arguments, after the `--` that ends the helper's own
/// argv. Nothing here is interpreted: the executor already chose the program
/// from its owner's reviewed configuration.
fn job_argv(values: &[String]) -> Result<Vec<String>, NativeError> {
    let usable = |value: &String| {
        !value.contains('\0') && value.len() <= MAX_JOB_ARGUMENT_LENGTH
    };
    match values.first() {
        Some(program) if !program.is_empty() && values.len() <= MAX_JOB_ARGUMENTS
            && values.iter().all(usable) => Ok(values.to_vec()),
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

pub fn parse_command(arguments: &[String]) -> Result<Command, NativeError> {
    match arguments {
        [command, separator, rest @ ..] if command == "job-run" && separator == "--" => {
            Ok(Command::JobRun(job_argv(rest)?))
        }
        [command] if command == "workspace-preflight" => Ok(Command::WorkspacePreflight),
        [command] if command == "workspace-apply" => Ok(Command::WorkspaceApply),
        [command, path] if command == "secure-directory" => {
            Ok(Command::SecureDirectory(state_path(path)?))
        }
        [command, path] if command == "secure-service-directory" => {
            Ok(Command::SecureServiceDirectory(state_path(path)?))
        }
        [command, path] if command == "verify-owner-only" => {
            Ok(Command::VerifyOwnerOnly(state_path(path)?))
        }
        [command, path] if command == "verify-owner-only-file" => {
            Ok(Command::VerifyOwnerOnlyFile(state_path(path)?))
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
            parse(&["verify-owner-only-file", r"C:\Users\person\AppData\Local\Nessie\executors\one\state.json"]),
            Ok(Command::VerifyOwnerOnlyFile(
                r"C:\Users\person\AppData\Local\Nessie\executors\one\state.json".to_owned(),
            )),
        );
        assert_eq!(
            parse(&["secure-directory", r"\\?\C:\Nessie\executors\one"]),
            Ok(Command::SecureDirectory(r"\\?\C:\Nessie\executors\one".to_owned())),
        );
        assert_eq!(parse(&["secure-directory", "C:/Nessie/executors/one"]).is_ok(), true);
        assert_eq!(
            parse(&["secure-service-directory", r"C:\ProgramData\Nessie Executor"]),
            Ok(Command::SecureServiceDirectory(r"C:\ProgramData\Nessie Executor".to_owned())),
        );
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

    #[test]
    fn job_run_passes_everything_after_the_separator_through_verbatim() {
        assert_eq!(
            parse(&["job-run", "--", r"C:\Tools\claude.exe", "-p", "--verbose", "--", "a b"]),
            Ok(Command::JobRun(vec![
                r"C:\Tools\claude.exe".to_owned(),
                "-p".to_owned(),
                "--verbose".to_owned(),
                "--".to_owned(),
                "a b".to_owned(),
            ])),
        );
        assert_eq!(parse(&["job-run", "--", "node"]), Ok(Command::JobRun(vec!["node".to_owned()])));
    }

    #[test]
    fn job_run_refuses_a_missing_separator_program_or_malformed_argument() {
        assert_eq!(parse(&["job-run"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["job-run", "--"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["job-run", "claude.exe"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["job-run", "--", ""]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["job-run", "--", "claude\0.exe"]), Err("EXECUTOR_NATIVE_USAGE"));
        let long = "a".repeat(super::MAX_JOB_ARGUMENT_LENGTH + 1);
        assert_eq!(parse(&["job-run", "--", "claude.exe", &long]), Err("EXECUTOR_NATIVE_USAGE"));
        let mut many = vec!["job-run", "--"];
        many.extend(std::iter::repeat("x").take(super::MAX_JOB_ARGUMENTS + 1));
        assert_eq!(parse(&many), Err("EXECUTOR_NATIVE_USAGE"));
    }
}
