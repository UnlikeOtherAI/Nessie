import Foundation

/// Which Nessie this build of the app is allowed to pair with.
///
/// The rule is `approved_api_base_url` in
/// `desktop/src-tauri/src/executor_companion.rs`, restated here rather than
/// widened: a development build reaches only its local API, and a release reaches
/// only the production origin. An app that accepted an arbitrary origin would be
/// a way to point somebody's machine key at a server nobody reviewed.
public enum ApprovedAPIOrigin {
    public static let production = "https://api.nessie.works"
    public static let localDevelopment = "http://127.0.0.1:5454"

    /// The origin a build defaults to when an invitation does not name one. The
    /// CLI validates the value again and refuses anything else, so this is a
    /// convenience, never an authorization.
    public static func `default`(isDevelopmentBuild: Bool) -> String {
        isDevelopmentBuild ? localDevelopment : production
    }

    public static func approve(
        _ value: String,
        isDevelopmentBuild: Bool
    ) -> Result<String, ExecutorRefusal> {
        let approved = `default`(isDevelopmentBuild: isDevelopmentBuild)
        guard value == approved else {
            return .failure(ExecutorRefusal(
                isDevelopmentBuild
                    ? "A development Nessie Executor build may pair only with its local API origin."
                    : "This Nessie Executor release may pair only with its approved API origin."
            ))
        }
        return .success(approved)
    }
}

/// A refusal a person reads. Every failure this app can produce is one of these,
/// so a panel never has to invent an explanation for a `nil`.
public struct ExecutorRefusal: Error, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}
