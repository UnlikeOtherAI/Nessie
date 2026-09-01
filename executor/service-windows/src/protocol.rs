//! The named-pipe control protocol: one JSON object per line, in and out.
//!
//! It is the desktop companion's five commands and nothing else — `status`,
//! `pair`, `start`, `stop`, `configure` — with the same argument validation, so
//! a person controlling the executor from the tray reaches exactly what a person
//! controlling it from **Agents → Executors** reaches. The one response rule the
//! design fixes: a response carries executor ids and daemon states, never a
//! path, a key, a challenge, or a child process's output.
//!
//! Everything here is a pure function of the request text, so both halves of the
//! contract are tested on any host.

use serde::{Deserialize, Serialize};

/// The workspace operations the local policy may allow, in canonical order.
pub const WORKSPACE_OPERATION_KEYS: [&str; 5] =
    ["file.list", "file.read", "file.write", "workspace.review", "sandbox.stop"];

/// The longest pairing challenge the API mints, matched to the desktop
/// companion's own bound so neither accepts what the other refuses.
const MAX_CHALLENGE_BYTES: usize = 8_192;

/// Windows' extended path limit. A workspace root longer than this cannot name
/// a real directory.
const MAX_WORKSPACE_BYTES: usize = 32_767;

const MAX_IDENTIFIER_BYTES: usize = 128;

/// The longest request line the pipe will read. A pairing challenge plus a
/// workspace path plus JSON framing fits with room to spare; anything larger is
/// a caller that has lost the protocol, not a command.
pub const MAX_REQUEST_BYTES: usize = 65_536;

#[cfg(debug_assertions)]
const APPROVED_API_BASE_URL: &str = "http://127.0.0.1:5454";
#[cfg(not(debug_assertions))]
const APPROVED_API_BASE_URL: &str = "https://api.nessie.works";

/// A validated command. Construction is the validation: nothing downstream
/// re-checks these, and nothing downstream may skip them.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Configure { executor_id: String, operation_keys: Vec<String> },
    Pair(PairCommand),
    Start { executor_id: String },
    Status,
    Stop { executor_id: String },
}

#[derive(Debug, PartialEq, Eq)]
/// The executor id is deliberately absent: the API assigns it and returns it in
/// the pairing reply, so the service stages the pairing under the enrollment id
/// and names the state directory only once the state file names an executor.
pub struct PairCommand {
    pub api_base_url: &'static str,
    pub challenge: String,
    pub enrollment_id: String,
    pub workspace_root: String,
}

/// The wire shape. Serde rejects an unknown command outright rather than
/// defaulting to one, and every field is validated after parsing.
/// `rename_all` names the commands; `rename_all_fields` names their arguments —
/// both are needed, because the first alone leaves the fields in snake case and
/// every request would parse as malformed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "command")]
enum Request {
    Configure { executor_id: String, operation_keys: Vec<String> },
    Pair {
        api_base_url: String,
        challenge: String,
        enrollment_id: String,
        workspace_root: String,
    },
    Start { executor_id: String },
    Status,
    Stop { executor_id: String },
}

/// One paired executor, as the tray is allowed to see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub daemon_status: String,
    pub executor_id: String,
    pub workspace_configured: bool,
}

/// The answer. There is no third variant on purpose: a caller parses one of two
/// shapes, and neither carries a place to put a path or a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Response {
    Error { reason: String },
    Ok { executors: Vec<ExecutorStatus> },
}

impl Response {
    pub fn error(reason: impl Into<String>) -> Self {
        Self::Error { reason: reason.into() }
    }

    /// One line, always terminated: the reader on the other side is line-framed.
    pub fn encode(&self) -> String {
        // The type is a closed set of strings and booleans, so serialization is
        // total; a failure here would be a bug in this file, not in a caller.
        format!("{}\n", serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"status":"error","reason":"The Nessie Executor service could not encode its answer."}"#
                .to_owned()
        }))
    }
}

/// The same rule the desktop companion applies to an executor id: it becomes a
/// path segment under the service's state root.
pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn identifier(value: String, field: &str) -> Result<String, String> {
    if valid_identifier(&value) {
        Ok(value)
    } else {
        Err(format!("The {field} is malformed."))
    }
}

fn approved_api_base_url(value: &str) -> Result<&'static str, String> {
    if value == APPROVED_API_BASE_URL {
        Ok(APPROVED_API_BASE_URL)
    } else {
        Err("This Nessie Executor release may pair only with its approved API origin.".to_owned())
    }
}

fn challenge(value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_CHALLENGE_BYTES || value.contains('\0') {
        return Err("The pairing challenge is malformed.".to_owned());
    }
    Ok(value)
}

fn workspace_root(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > MAX_WORKSPACE_BYTES
        || value.contains('\0')
        || !std::path::Path::new(&value).is_absolute()
    {
        return Err("Choose one existing absolute workspace directory.".to_owned());
    }
    Ok(value)
}

/// Canonicalizes the requested policy the way the desktop companion does: a
/// known set, each key at most once, always in the one declared order.
pub fn workspace_operation_keys(requested: Vec<String>) -> Result<Vec<String>, String> {
    if requested.is_empty()
        || requested.len() > WORKSPACE_OPERATION_KEYS.len()
        || requested.iter().any(|key| !WORKSPACE_OPERATION_KEYS.contains(&key.as_str()))
    {
        return Err("Choose one or more supported workspace operations.".to_owned());
    }
    let mut unique = requested.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != requested.len() {
        return Err("Choose each workspace operation only once.".to_owned());
    }
    Ok(WORKSPACE_OPERATION_KEYS
        .iter()
        .filter(|key| requested.iter().any(|value| value == *key))
        .map(|key| (*key).to_owned())
        .collect())
}

/// Parses and validates one request line. A malformed line is refused in words
/// that never quote the line back: it may hold a pairing challenge.
pub fn parse_request(line: &str) -> Result<Command, String> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err("The control request is malformed.".to_owned());
    }
    let request: Request = serde_json::from_str(line)
        .map_err(|_| "The control request is malformed.".to_owned())?;
    match request {
        Request::Configure { executor_id, operation_keys } => Ok(Command::Configure {
            executor_id: identifier(executor_id, "executor id")?,
            operation_keys: workspace_operation_keys(operation_keys)?,
        }),
        Request::Pair {
            api_base_url,
            challenge: value,
            enrollment_id,
            workspace_root: workspace,
        } => Ok(Command::Pair(PairCommand {
            api_base_url: approved_api_base_url(&api_base_url)?,
            challenge: challenge(value)?,
            enrollment_id: identifier(enrollment_id, "enrollment id")?,
            workspace_root: workspace_root(workspace)?,
        })),
        Request::Start { executor_id } => {
            Ok(Command::Start { executor_id: identifier(executor_id, "executor id")? })
        }
        Request::Status => Ok(Command::Status),
        Request::Stop { executor_id } => {
            Ok(Command::Stop { executor_id: identifier(executor_id, "executor id")? })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_request, valid_identifier, workspace_operation_keys, Command, ExecutorStatus,
        Response, MAX_REQUEST_BYTES,
    };

    const EXECUTOR: &str = "00000000-0000-4000-8000-000000000001";

    fn pair_line(challenge: &str, workspace: &str) -> String {
        let api = if cfg!(debug_assertions) {
            "http://127.0.0.1:5454"
        } else {
            "https://api.nessie.works"
        };
        format!(
            r#"{{"command":"pair","apiBaseUrl":"{api}","challenge":"{challenge}","enrollmentId":"{EXECUTOR}","workspaceRoot":"{workspace}"}}"#,
        )
    }

    fn absolute_workspace() -> &'static str {
        if cfg!(windows) {
            "C:\\\\Users\\\\person\\\\work"
        } else {
            "/home/person/work"
        }
    }

    #[test]
    fn accepts_only_safe_executor_identifiers() {
        assert!(valid_identifier(EXECUTOR));
        for value in ["", "../state", "a/b", "a\\b", "a b", &"a".repeat(129)] {
            assert!(!valid_identifier(value), "identifier {value:?} must be refused");
        }
        assert_eq!(
            parse_request(r#"{"command":"start","executorId":"../state"}"#),
            Err("The executor id is malformed.".to_owned()),
        );
    }

    #[test]
    fn the_five_companion_commands_are_the_whole_protocol() {
        assert_eq!(parse_request(r#"{"command":"status"}"#).unwrap(), Command::Status);
        assert_eq!(
            parse_request(&format!(r#"{{"command":"start","executorId":"{EXECUTOR}"}}"#)).unwrap(),
            Command::Start { executor_id: EXECUTOR.to_owned() },
        );
        assert_eq!(
            parse_request(&format!(r#"{{"command":"stop","executorId":"{EXECUTOR}"}}"#)).unwrap(),
            Command::Stop { executor_id: EXECUTOR.to_owned() },
        );
        // A sixth command is not a command: nothing here falls back to `status`.
        for line in [
            r#"{"command":"uninstall"}"#,
            r#"{"command":"serve"}"#,
            r#"{}"#,
            "not json",
            "",
        ] {
            assert_eq!(
                parse_request(line),
                Err("The control request is malformed.".to_owned()),
                "line {line:?} must be refused",
            );
        }
    }

    #[test]
    fn a_pairing_challenge_is_bounded_and_never_quoted_back() {
        let parsed = parse_request(&pair_line("challenge-value", absolute_workspace())).unwrap();
        let Command::Pair(command) = parsed else { panic!("a pair line must parse as pair") };
        assert_eq!(command.challenge, "challenge-value");
        for challenge in ["", &"c".repeat(8_193)] {
            let refusal = parse_request(&pair_line(challenge, absolute_workspace())).unwrap_err();
            assert_eq!(refusal, "The pairing challenge is malformed.");
            assert!(!refusal.contains(challenge) || challenge.is_empty());
        }
        // An oversized line is refused before it is parsed at all.
        assert_eq!(
            parse_request(&"x".repeat(MAX_REQUEST_BYTES + 1)),
            Err("The control request is malformed.".to_owned()),
        );
    }

    #[test]
    fn pairing_refuses_an_api_origin_this_release_does_not_serve() {
        let line = pair_line("challenge-value", absolute_workspace())
            .replace("api.nessie.works", "api.example.test")
            .replace("127.0.0.1", "10.0.0.1");
        assert_eq!(
            parse_request(&line),
            Err("This Nessie Executor release may pair only with its approved API origin.".to_owned()),
        );
    }

    #[test]
    fn pairing_requires_one_absolute_workspace_directory() {
        for workspace in ["", "work", "./work"] {
            assert_eq!(
                parse_request(&pair_line("challenge-value", workspace)),
                Err("Choose one existing absolute workspace directory.".to_owned()),
                "workspace {workspace:?} must be refused",
            );
        }
    }

    #[test]
    fn canonicalizes_workspace_policy_without_browser_or_coding_operations() {
        assert_eq!(
            workspace_operation_keys(vec!["sandbox.stop".to_owned(), "file.read".to_owned()])
                .unwrap(),
            vec!["file.read", "sandbox.stop"],
        );
        assert!(workspace_operation_keys(vec!["browser.open".to_owned()]).is_err());
        assert!(workspace_operation_keys(Vec::new()).is_err());
        assert!(
            workspace_operation_keys(vec!["file.read".to_owned(), "file.read".to_owned()]).is_err()
        );
    }

    /// The response rule, asserted on the encoding rather than restated: the
    /// only keys that ever leave the service are these.
    #[test]
    fn a_response_carries_executor_ids_and_states_and_nothing_else() {
        let encoded = Response::Ok {
            executors: vec![ExecutorStatus {
                daemon_status: "running".to_owned(),
                executor_id: EXECUTOR.to_owned(),
                workspace_configured: true,
            }],
        }
        .encode();
        assert!(encoded.ends_with('\n'));
        assert_eq!(
            encoded.trim_end(),
            format!(
                r#"{{"status":"ok","executors":[{{"daemonStatus":"running","executorId":"{EXECUTOR}","workspaceConfigured":true}}]}}"#,
            ),
        );
        let refusal = Response::error("This executor has not been paired on this computer.").encode();
        assert_eq!(
            refusal.trim_end(),
            r#"{"status":"error","reason":"This executor has not been paired on this computer."}"#,
        );
    }
}
