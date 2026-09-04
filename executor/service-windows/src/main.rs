//! `nessie-executor-service.exe` — the standalone package's daemon host.
//!
//! Started by the Service Control Manager with no arguments, it becomes the
//! `NessieExecutor` service. It has exactly one other mode, and it exists for
//! the installer: `--join-hyperv-administrators` puts the virtual service
//! account into the Hyper-V Administrators alias, as a deferred custom action
//! after the service is created. Both modes and nothing else — a control surface
//! belongs on the pipe, where the DACL decides who reaches it.
//!
//! Everything except the Win32 modules also compiles and runs its tests on a
//! non-Windows host, deliberately: the protocol's validation, the manifest
//! rules, the lease decision and the argument builders are where the behaviour
//! lives, and a check that only ever runs on the release machine is a check
//! nobody runs. On such a host the service entry points are stubs, so almost
//! every item is unreachable — hence the one allow below, which is scoped to
//! that build alone and never applies to the shipped binary.
#![cfg_attr(not(windows), allow(dead_code))]

mod control;
mod helper;
mod hyperv;
mod lease;
mod log;
mod manifest;
mod paths;
#[cfg(windows)]
mod pipe;
mod protocol;
mod provenance;
#[cfg(windows)]
mod security;
mod service;
mod supervisor;

const USAGE: &str = "nessie-executor-service runs as the Nessie Executor Windows service. \
                     Its only other mode is --join-hyperv-administrators, which the installer \
                     uses after registering the service.";

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    JoinHypervAdministrators,
    RunService,
}

fn parse_mode(arguments: &[String]) -> Result<Mode, String> {
    match arguments {
        [] => Ok(Mode::RunService),
        [only] if only == "--join-hyperv-administrators" => Ok(Mode::JoinHypervAdministrators),
        _ => Err(USAGE.to_owned()),
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match parse_mode(&arguments) {
        Ok(Mode::RunService) => service::run(),
        Ok(Mode::JoinHypervAdministrators) => hyperv::join_hyperv_administrators(),
        Err(usage) => Err(usage),
    };
    if let Err(reason) = outcome {
        // A custom action reads the exit code; the SCM reads the service status.
        // Either way the reason belongs on stderr rather than in a dialog no
        // unattended install would ever show.
        eprintln!("{reason}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mode, Mode, USAGE};

    #[test]
    fn no_arguments_means_the_service_control_manager_started_it() {
        assert_eq!(parse_mode(&[]), Ok(Mode::RunService));
    }

    #[test]
    fn the_installers_one_extra_mode_is_the_only_extra_mode() {
        assert_eq!(
            parse_mode(&["--join-hyperv-administrators".to_owned()]),
            Ok(Mode::JoinHypervAdministrators),
        );
        for arguments in [
            vec!["--pair".to_owned()],
            vec!["status".to_owned()],
            vec!["--join-hyperv-administrators".to_owned(), "extra".to_owned()],
            vec!["--join-hyperv-administrators=1".to_owned()],
        ] {
            assert_eq!(
                parse_mode(&arguments),
                Err(USAGE.to_owned()),
                "arguments {arguments:?} must be refused",
            );
        }
    }
}
