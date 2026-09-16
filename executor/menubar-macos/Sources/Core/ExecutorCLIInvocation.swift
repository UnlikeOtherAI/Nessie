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

    /// The challenge and the workspace path travel on standard input, never in
    /// `argv`: a pairing challenge in a process list is a credential anybody
    /// signed into this Mac can read.
    ///
    /// Pairing sends the single `workspaceRoot` spelling on purpose: a person
    /// pairing a Mac has chosen one folder and has not been asked to name it,
    /// and the CLI derives the name from the directory. Naming and adding more
    /// folders is the reach surface's job, afterwards.
    public static func pair(
        apiBaseUrl: String,
        enrollmentId: String,
        challenge: String,
        workspaceRoot: String,
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: [
                "pair",
                "--api", apiBaseUrl,
                "--enrollment", enrollmentId,
                "--pair-input-stdin",
                "--state-dir", stateDirectory,
            ],
            standardInput: try canonicalJSON([
                "challenge": challenge,
                "workspaceRoot": workspaceRoot,
            ])
        )
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

/// What `pair` prints when it succeeds. The fingerprint is the whole point of
/// the pairing surface — a person compares it in Nessie before the executor is
/// allowed to do anything — so it is read out of the CLI's own success line
/// rather than recomputed here from the machine key, which this app never sees.
public enum PairingOutput {
    public static func fingerprint(in standardOutput: String) -> String? {
        guard let range = standardOutput.range(of: "Confirm fingerprint ") else { return nil }
        let rest = standardOutput[range.upperBound...]
        let fingerprint = rest.prefix { !$0.isWhitespace }
        return fingerprint.isEmpty ? nil : String(fingerprint)
    }
}
