import Foundation

/// The grammar a permitted program has to satisfy, restated so the Tools panel
/// can refuse in words a person can act on instead of showing the CLI's exit
/// status. It is a *pre*-check, never the decision: `configure` runs
/// `ExecutorCommandAllowlistSchema` (packages/schemas/src/executor.ts) over the
/// same list and its answer is the one that lands in the policy.
public enum PermittedProgram {
    /// `EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM` in packages/schemas/src/executor.ts.
    public static let maximumCount = 64
    private static let shells = ["bash", "dash", "fish", "ksh", "sh", "zsh"]

    /// The one refusal the CLI raises for a malformed list, word for word.
    public static let grammarRefusal =
        "Permitted programs are distinct bare names the guest resolves through its "
        + "fixed PATH — no paths, no shells, at most \(maximumCount)."

    public static func validate(
        adding program: String,
        to existing: [String]
    ) -> Result<[String], ExecutorRefusal> {
        let name = program.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 256,
              !name.contains("\0"), !name.contains("/"),
              !shells.contains(name)
        else {
            return .failure(ExecutorRefusal(grammarRefusal))
        }
        guard !existing.contains(name) else {
            return .failure(ExecutorRefusal("\(name) is already a permitted program."))
        }
        guard existing.count + 1 <= maximumCount else {
            return .failure(ExecutorRefusal(grammarRefusal))
        }
        return .success((existing + [name]).sorted())
    }

    /// Removing the last program while `command.run` is enabled is refused here
    /// for the same reason `configure` refuses it: an operation that can never
    /// succeed is a misconfiguration, not a policy.
    public static func validate(
        removing program: String,
        from existing: [String],
        commandRunEnabled: Bool
    ) -> Result<[String], ExecutorRefusal> {
        let remaining = existing.filter { $0 != program }
        guard remaining.count != existing.count else {
            return .failure(ExecutorRefusal("\(program) is not a permitted program."))
        }
        if commandRunEnabled && remaining.isEmpty {
            return .failure(ExecutorRefusal(
                "Name at least one permitted program before enabling command.run. Turn off "
                    + "command.run in Nessie first, or keep one program on the list."
            ))
        }
        return .success(remaining)
    }
}
