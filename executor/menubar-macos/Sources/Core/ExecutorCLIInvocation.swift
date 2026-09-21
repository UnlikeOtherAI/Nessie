import Foundation

/// Every way this app speaks to `nessie-executor`, as data.
///
/// The app is a client of that CLI, never a second writer of executor state, so
/// this file is the complete list of what it can ask for. Building the argument
/// vector and the standard-input payload as a value — rather than inside the
/// process-spawning code — is what lets a test assert the one property that
/// matters: a pairing challenge and a workspace path never appear in `argv`,
/// where every process on this Mac could read them.
public struct ExecutorCLIInvocation: Equatable, Sendable {
    public let arguments: [String]
    /// Written to the child's stdin and closed. `nil` means stdin is not a pipe.
    public let standardInput: Data?

    public init(arguments: [String], standardInput: Data? = nil) {
        self.arguments = arguments
        self.standardInput = standardInput
    }
}

public enum ExecutorCLI {
    public static func describe(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["describe", "--state-dir", stateDirectory])
    }

    public static func connect(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["connect", "--state-dir", stateDirectory])
    }

    /// The daemon. `--parent-liveness-stdin` is what makes the app's supervision
    /// real: the daemon watches that pipe and tears its guests down when it
    /// closes, so it cannot outlive the app that started it. The same contract
    /// `desktop/src-tauri/src/executor_companion/runtime.rs` uses on macOS.
    public static func serve(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["serve", "--parent-liveness-stdin", "--state-dir", stateDirectory])
    }

    /// The runtime owns key generation, pending state and replacement. The app
    /// sends the selected folder through stdin so paths stay off process lists.
    public static func pairingStart(
        apiBaseUrl: String,
        workspaceRoot: String,
        replace: Bool,
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: [
                "pairing-start", "--json",
                "--api", apiBaseUrl,
                "--pairing-input-stdin",
                "--state-dir", stateDirectory,
            ],
            standardInput: try canonicalJSON([
                "replace": replace,
                "workspaceRoot": workspaceRoot,
            ])
        )
    }

    public static func pairingStatus(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["pairing-status", "--json", "--state-dir", stateDirectory])
    }

    public static func pairingConfirm(stateDirectory: String, claimDigest: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: [
            "pairing-confirm", "--json", "--state-dir", stateDirectory, "--claim-digest", claimDigest,
        ])
    }

    public static func pairingCancel(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["pairing-cancel", "--json", "--state-dir", stateDirectory])
    }

    /// One local-policy proposal. Operations, folders and permitted commands are
    /// always stated together because that is what `configure
    /// --configuration-input-stdin` reads; a section that changed one of them
    /// re-states the other two exactly as `describe` reported them, so no
    /// section can silently narrow a policy it was not editing.
    ///
    /// The folders go over as `workspaceFolders`, the named form. The older
    /// `workspaceRoot` spelling is still accepted by the CLI, but it derives a
    /// name from the directory — which would rename a person's folder the moment
    /// this app re-stated a policy it was not editing.
    public static func configure(
        operationKeys: [String],
        workspaceFolders: [ExecutorDescription.Folder],
        commandAllowlist: [String],
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: ["configure", "--configuration-input-stdin", "--state-dir", stateDirectory],
            standardInput: try canonicalJSON([
                "commandAllowlist": commandAllowlist,
                "operationKeys": operationKeys,
                "workspaceFolders": workspaceFolders.map { ["name": $0.name, "path": $0.path] },
            ])
        )
    }

    private static func canonicalJSON(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
