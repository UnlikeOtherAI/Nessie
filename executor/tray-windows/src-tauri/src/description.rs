//! The JSON `nessie-executor describe` prints, and the only shape the tray
//! renders.
//!
//! The tray is a client of the CLI, never a second reader of
//! `executor-state.json`, so this file is the one interpretation it ever holds.
//! The machine key never appears here.

use serde::{Deserialize, Serialize};

/// What `nessie-executor describe` returns. Every field is read-only: the
/// tray paints it, and any change is handed back to the CLI through
/// `configure --configuration-input-stdin`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorDescription {
    pub api_base_url: String,
    pub executor_id: String,
    pub policy: Policy,
    pub reach: Reach,
    pub sandbox: Sandbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub limits: Limits,
    pub operations: Vec<String>,
    /// Empty means no command may start, not "no restriction".
    pub permitted_programs: Vec<String>,
    pub profiles: Vec<String>,
    pub revision: i64,
    /// The folder names the last proposed revision names. Empty means the
    /// descriptor predates named folders.
    pub workspace_folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_command_runtime_seconds: i64,
    pub max_result_bytes: i64,
    pub max_sessions: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    /// HTTPS origins the guest browser may open; empty until one is configured.
    pub allowed_origins: Vec<String>,
    /// The read-only host folders this executor is paired against, by the name
    /// that starts every workspace path an agent writes.
    pub folders: Vec<Folder>,
    pub guest_sessions: GuestSessions,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuestSessions {
    Available,
    RefusedMultipleFolders,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub browser_configured: bool,
    pub coding_configured: bool,
    pub promotion_helper_configured: bool,
}

impl ExecutorDescription {
    /// Enough of an executor id to tell two apart, and never so much that a
    /// line grows wider than the window. Ids are UUIDs; the first segment is
    /// what a person compares against the Executors page in Nessie.
    pub fn short_executor_id(&self) -> String {
        self.executor_id.split('-').next().unwrap_or(&self.executor_id).to_owned()
    }

    /// Whether the reviewed local policy has enabled `command.run`. The tools
    /// surface uses this to decide whether an empty command list is a
    /// misconfiguration.
    pub fn command_run_enabled(&self) -> bool {
        self.policy.operations.iter().any(|operation| operation == "command.run")
    }

    /// What the reach surface says about guest sessions, in a person's terms.
    /// A guest VM mounts one workspace, so this is a refusal to state rather
    /// than a detail to hide.
    pub fn guest_session_note(&self) -> &'static str {
        match self.reach.guest_sessions {
            GuestSessions::Available => {
                "A sandboxed command or coding session can start: exactly one folder is configured."
            }
            GuestSessions::RefusedMultipleFolders => {
                "Sandboxed commands and coding sessions refuse to start while more than one folder \
                 is configured — a guest mounts one workspace, so it would otherwise bind to \
                 whichever folder came first. Listing, reading, writing and reviewing files work \
                 across all of them."
            }
        }
    }

    /// Builds the configuration payload the CLI reads on stdin. Re-stating
    /// every field the CLI expects means a section that changes one thing
    /// cannot silently narrow the parts it is not editing.
    pub fn configuration_input(&self) -> serde_json::Value {
        serde_json::json!({
            "commandAllowlist": self.policy.permitted_programs,
            "operationKeys": self.policy.operations,
            "workspaceFolders": self.reach.folders.iter().map(|folder| {
                serde_json::json!({ "name": folder.name, "path": folder.path })
            }).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ExecutorDescription, Folder, GuestSessions, Limits, Policy, Reach, Sandbox,
    };

    fn sample_description() -> ExecutorDescription {
        ExecutorDescription {
            api_base_url: "https://api.nessie.works".to_owned(),
            executor_id: "1f2e3d4c-0000-4000-8000-000000000001".to_owned(),
            policy: Policy {
                limits: Limits {
                    max_command_runtime_seconds: 60,
                    max_result_bytes: 1_048_576,
                    max_sessions: 4,
                },
                operations: vec!["file.read".to_owned(), "command.run".to_owned()],
                permitted_programs: vec!["git *".to_owned()],
                profiles: vec![],
                revision: 3,
                workspace_folders: vec!["nessie".to_owned()],
            },
            reach: Reach {
                allowed_origins: vec!["https://github.com".to_owned()],
                folders: vec![Folder {
                    name: "nessie".to_owned(),
                    path: "/home/person/nessie".to_owned(),
                }],
                guest_sessions: GuestSessions::Available,
            },
            sandbox: Sandbox {
                browser_configured: true,
                coding_configured: false,
                promotion_helper_configured: false,
            },
        }
    }

    #[test]
    fn short_id_is_the_first_uuid_segment() {
        let description = sample_description();
        assert_eq!(description.short_executor_id(), "1f2e3d4c");
    }

    #[test]
    fn command_run_enabled_is_derived_from_operations() {
        let mut description = sample_description();
        assert!(description.command_run_enabled());
        description.policy.operations.clear();
        assert!(!description.command_run_enabled());
    }

    #[test]
    fn guest_session_note_names_the_single_folder_rule() {
        let mut description = sample_description();
        assert!(!description.guest_session_note().contains("refuse"));
        description.reach.guest_sessions = GuestSessions::RefusedMultipleFolders;
        assert!(description.guest_session_note().contains("refuse"));
    }

    #[test]
    fn configuration_input_restates_every_cli_field() {
        let description = sample_description();
        let input = description.configuration_input();
        assert_eq!(
            input["operationKeys"].as_array().unwrap(),
            &vec![serde_json::json!("file.read"), serde_json::json!("command.run")],
        );
        assert_eq!(
            input["commandAllowlist"].as_array().unwrap(),
            &vec![serde_json::json!("git *")],
        );
        let folders = input["workspaceFolders"].as_array().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["name"], "nessie");
        assert_eq!(folders[0]["path"], "/home/person/nessie");
    }

    #[test]
    fn decodes_the_describe_json_shape() {
        let json = serde_json::json!({
            "apiBaseUrl": "https://api.nessie.works",
            "executorId": "1f2e3d4c-0000-4000-8000-000000000001",
            "policy": {
                "limits": { "maxCommandRuntimeSeconds": 60, "maxResultBytes": 1048576, "maxSessions": 4 },
                "operations": ["file.read"],
                "permittedPrograms": [],
                "profiles": [],
                "revision": 1,
                "workspaceFolders": []
            },
            "reach": {
                "allowedOrigins": [],
                "folders": [{ "name": "workspace", "path": "/home/person/work" }],
                "guestSessions": "refused_multiple_folders"
            },
            "sandbox": { "browserConfigured": false, "codingConfigured": false, "promotionHelperConfigured": false }
        });
        let description: ExecutorDescription =
            serde_json::from_value(json).expect("describe shape must decode");
        assert_eq!(description.reach.folders[0].name, "workspace");
        assert_eq!(description.reach.guest_sessions, GuestSessions::RefusedMultipleFolders);
    }
}
