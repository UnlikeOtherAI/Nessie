//! The named-pipe control protocol: one JSON object per line, in and out.
//!
//! The tray is a stateless client of the CLI, so the protocol exposes the
//! commands it needs: `status`, `pair`, `start`, `stop`, `describe`, and
//! `configureInput`. `describe` returns the same credential-free JSON the CLI
//! prints; `configureInput` carries the whole stdin payload for
//! `configure --configuration-input-stdin`. This keeps the tray from ever
//! opening `executor-state.json` while still letting it show folders, origins,
//! and permitted commands.
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

const NESSIE_API_BASE_URL: &str = "https://api.nessie.works";
const DEEPTEST_API_BASE_URL: &str = "https://api.deeptest.live";
const LOOPBACK_API_BASE_URLS: [&str; 2] = ["http://127.0.0.1:5454", "http://localhost:5454"];

/// A validated command. Construction is the validation: nothing downstream
/// re-checks these, and nothing downstream may skip them.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Configure { executor_id: String, operation_keys: Vec<String> },
    ConfigureInput { executor_id: String, configuration_input: serde_json::Value },
    Describe { executor_id: String },
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
    pub api_base_url: String,
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
    ConfigureInput { executor_id: String, configuration_input: serde_json::Value },
    Describe { executor_id: String },
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

/// The answer. Each variant carries only what the tray asked for: an executor
/// list, a pairing result, or the credential-free `describe` JSON. Paths that
/// belong to the person reading them travel only inside `describe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum Response {
    Error { reason: String },
    Ok { executors: Vec<ExecutorStatus> },
    #[serde(rename = "pairOk")]
    PairOk { executor_id: String, fingerprint: String },
    #[serde(rename = "describe")]
    DescribeOk { description: serde_json::Value },
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

fn approved_api_base_url(value: &str) -> Result<String, String> {
    if value == NESSIE_API_BASE_URL || value == DEEPTEST_API_BASE_URL {
        return Ok(value.to_owned());
    }
    // A local owner may deliberately pair to this machine's development API.
    // This is a closed loopback set, not a general HTTP exception: a pasted
    // invitation can never route the machine key to a LAN or internet host.
    if LOOPBACK_API_BASE_URLS.contains(&value) {
        return Ok(value.to_owned());
    }
    // Nessie is open source and self-hosted. Anything else must be an HTTPS
    // origin with no credentials, path, query or fragment — the same rule the
    // shared schema enforces so one host cannot be dressed up as another.
    let parsed = value
        .parse::<url::Url>()
        .map_err(|_| "Choose Nessie cloud, DeepTest, an approved local API, or an HTTPS origin.".to_owned())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("A pairing address carries no username or password.".to_owned());
    }
    if parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.path() == "/" || parsed.path().is_empty())
    {
        return Err("A pairing address is an origin only — no path, query or fragment.".to_owned());
    }
    if parsed.scheme() == "https" {
        Ok(parsed.origin().unicode_serialization())
    } else {
        Err("A pairing address must be HTTPS.".to_owned())
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
        Request::ConfigureInput { executor_id, configuration_input } => Ok(Command::ConfigureInput {
            executor_id: identifier(executor_id, "executor id")?,
            configuration_input,
        }),
        Request::Describe { executor_id } => Ok(Command::Describe {
            executor_id: identifier(executor_id, "executor id")?,
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
        Response, LOOPBACK_API_BASE_URLS, MAX_REQUEST_BYTES, NESSIE_API_BASE_URL,
    };

    const EXECUTOR: &str = "00000000-0000-4000-8000-000000000001";

    fn pair_line(challenge: &str, workspace: &str) -> String {
        format!(
            r#"{{"command":"pair","apiBaseUrl":"{NESSIE_API_BASE_URL}","challenge":"{challenge}","enrollmentId":"{EXECUTOR}","workspaceRoot":"{workspace}"}}"#,
        )
    }

    fn pair_line_with_api(api: &str, challenge: &str, workspace: &str) -> String {
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
    fn the_seven_companion_commands_are_the_whole_protocol() {
        assert_eq!(parse_request(r#"{"command":"status"}"#).unwrap(), Command::Status);
        assert_eq!(
            parse_request(&format!(r#"{{"command":"start","executorId":"{EXECUTOR}"}}"#)).unwrap(),
            Command::Start { executor_id: EXECUTOR.to_owned() },
        );
        assert_eq!(
            parse_request(&format!(r#"{{"command":"stop","executorId":"{EXECUTOR}"}}"#)).unwrap(),
            Command::Stop { executor_id: EXECUTOR.to_owned() },
        );
        assert_eq!(
            parse_request(&format!(r#"{{"command":"describe","executorId":"{EXECUTOR}"}}"#)).unwrap(),
            Command::Describe { executor_id: EXECUTOR.to_owned() },
        );
        assert_eq!(
            parse_request(&format!(r#"{{"command":"configureInput","executorId":"{EXECUTOR}","configurationInput":{{}}}}"#)).unwrap(),
            Command::ConfigureInput { executor_id: EXECUTOR.to_owned(), configuration_input: serde_json::json!({}) },
        );
        // An eighth command is not a command: nothing here falls back to `status`.
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
    fn pairing_accepts_self_hosted_https_and_refuses_everything_else() {
        let https = pair_line_with_api("https://api.example.test", "challenge-value", absolute_workspace());
        assert!(
            matches!(parse_request(&https).unwrap(), Command::Pair(_)),
            "a self-hosted HTTPS origin must be accepted",
        );
        let http = pair_line_with_api("http://api.example.test", "challenge-value", absolute_workspace());
        assert_eq!(
            parse_request(&http),
            Err("A pairing address must be HTTPS.".to_owned()),
        );
        let with_path = pair_line_with_api(
            "https://api.example.test/api.nessie.works",
            "challenge-value",
            absolute_workspace(),
        );
        assert_eq!(
            parse_request(&with_path),
            Err("A pairing address is an origin only — no path, query or fragment.".to_owned()),
        );
    }

    #[test]
    fn every_build_accepts_both_spellings_of_the_local_development_api() {
        for api in LOOPBACK_API_BASE_URLS {
            let line = pair_line_with_api(api, "challenge-value", absolute_workspace());
            assert!(parse_request(&line).is_ok(), "{api} must be accepted");
        }
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

    /// The response rule, asserted on the encoding rather than restated: every
    /// variant declares its shape in the `status` tag.
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

    #[test]
    fn a_pair_ok_response_carries_executor_id_and_fingerprint() {
        let encoded = Response::PairOk {
            executor_id: EXECUTOR.to_owned(),
            fingerprint: "abc123".to_owned(),
        }
        .encode();
        assert_eq!(
            encoded.trim_end(),
            format!(r#"{{"status":"pairOk","executorId":"{EXECUTOR}","fingerprint":"abc123"}}"#),
        );
    }

    #[test]
    fn a_describe_response_carries_the_description_json() {
        let encoded = Response::DescribeOk {
            description: serde_json::json!({ "executorId": EXECUTOR }),
        }
        .encode();
        assert_eq!(
            encoded.trim_end(),
            format!(r#"{{"status":"describe","description":{{"executorId":"{EXECUTOR}"}}}}"#),
        );
    }
}
