import Foundation

/// Reading the invitation a person copied out of **Agents → Executors**.
///
/// The Swift sibling of `executor/tray-windows/src-tauri/src/invitation.rs`, with
/// the same two accepted shapes and the same refusals: that page offers one thing
/// to copy, the `nessie-executor pair …` command carrying `--api`, `--enrollment`
/// and `--challenge`, and somebody pasting the link instead is reading the same
/// two values off the same page. A text that carries neither pair is refused
/// rather than guessed at.
public struct Invitation: Equatable, Sendable {
    public let apiBaseUrl: String
    public let challenge: String
    public let enrollmentId: String

    public init(apiBaseUrl: String, challenge: String, enrollmentId: String) {
        self.apiBaseUrl = apiBaseUrl
        self.challenge = challenge
        self.enrollmentId = enrollmentId
    }
}

public enum InvitationParser {
    public static func parse(
        _ text: String,
        isDevelopmentBuild: Bool
    ) -> Result<Invitation, ExecutorRefusal> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return .failure(ExecutorRefusal("Paste the invitation from Agents → Executors in Nessie."))
        }
        let tokens = trimmed.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let enrollmentId = nonEmpty(flagValue(tokens, "--enrollment") ?? queryValue(trimmed, "enrollmentId"))
        let challenge = nonEmpty(flagValue(tokens, "--challenge") ?? queryValue(trimmed, "challenge"))
        guard let enrollmentId, let challenge else {
            return .failure(ExecutorRefusal(
                "That is not a Nessie executor invitation. Copy the pairing command or link from "
                    + "Agents → Executors."
            ))
        }
        let api = nonEmpty(flagValue(tokens, "--api") ?? queryValue(trimmed, "api"))
        return .success(Invitation(
            apiBaseUrl: api ?? ApprovedAPIOrigin.default(isDevelopmentBuild: isDevelopmentBuild),
            challenge: challenge,
            enrollmentId: enrollmentId
        ))
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private static func unquote(_ value: String) -> String {
        for quote in ["\"", "'"] where value.hasPrefix(quote) && value.hasSuffix(quote) && value.count >= 2 {
            return String(value.dropFirst().dropLast())
        }
        return value
    }

    /// `--flag value` and `--flag=value` both appear in things people paste.
    private static func flagValue(_ tokens: [String], _ flag: String) -> String? {
        let prefix = "\(flag)="
        for (index, token) in tokens.enumerated() {
            if token.hasPrefix(prefix) {
                return unquote(String(token.dropFirst(prefix.count)))
            }
            if token == flag {
                guard let next = tokens[safe: index + 1], !next.hasPrefix("--") else { return nil }
                return unquote(next)
            }
        }
        return nil
    }

    private static func percentDecode(_ value: String) -> String {
        value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
            ?? value.replacingOccurrences(of: "+", with: " ")
    }

    private static func queryValue(_ text: String, _ key: String) -> String? {
        guard let questionMark = text.firstIndex(of: "?") else { return nil }
        let query = text[text.index(after: questionMark)...]
        for pair in query.split(whereSeparator: { $0 == "&" || $0 == "#" }) {
            guard let equals = pair.firstIndex(of: "=") else { continue }
            if pair[..<equals] == key {
                return percentDecode(String(pair[pair.index(after: equals)...]))
            }
        }
        return nil
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
