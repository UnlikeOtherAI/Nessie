import Foundation

/// The JSON `nessie-executor describe` prints, and the only shape this app
/// renders. `executor/src/describe.ts` is its producer; nothing here reads
/// `executor-state.json`, so the app can never hold a second interpretation of
/// a local policy the daemon enforces.
public struct ExecutorDescription: Equatable, Decodable, Sendable {
    public struct Limits: Equatable, Decodable, Sendable {
        public let maxCommandRuntimeSeconds: Int
        public let maxResultBytes: Int
        public let maxSessions: Int
    }

    public struct Policy: Equatable, Decodable, Sendable {
        public let limits: Limits
        public let operations: [String]
        /// Empty means no program may start, not "no restriction".
        public let permittedPrograms: [String]
        public let profiles: [String]
        public let revision: Int
    }

    public struct Reach: Equatable, Decodable, Sendable {
        /// HTTPS origins the guest browser may open; empty until one is configured.
        public let allowedOrigins: [String]
        /// The single read-only host directory this executor was paired against.
        public let workspaceRoot: String
    }

    public struct Sandbox: Equatable, Decodable, Sendable {
        public let browserConfigured: Bool
        public let codingConfigured: Bool
        public let promotionHelperConfigured: Bool
    }

    public let apiBaseUrl: String
    public let executorId: String
    public let policy: Policy
    public let reach: Reach
    public let sandbox: Sandbox

    public static func decode(_ data: Data) throws -> ExecutorDescription {
        try JSONDecoder().decode(ExecutorDescription.self, from: data)
    }

    /// Enough of an executor id to tell two apart, and never so much that a menu
    /// line grows wider than the screen. Ids are UUIDs; the first segment is
    /// what a person compares against the Executors page in Nessie.
    public var shortExecutorId: String {
        String(executorId.split(separator: "-").first ?? Substring(executorId))
    }

    /// The folder name a person recognises. The full path stays on this computer
    /// either way, and the panels show it in full beside this label.
    public var workspaceLabel: String {
        let name = (reach.workspaceRoot as NSString).lastPathComponent
        return name.isEmpty || name == "/" ? reach.workspaceRoot : name
    }

    public var commandRunEnabled: Bool { policy.operations.contains(ExecutorPolicy.commandOperationKey) }
}

public enum ExecutorPolicy {
    public static let commandOperationKey = "command.run"
}
