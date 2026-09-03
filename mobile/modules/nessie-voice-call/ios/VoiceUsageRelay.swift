import Foundation

/// Relays per-turn spend for one call, in order.
///
/// Google emits several `usageMetadata` updates within a turn; only the last is
/// that turn's billable snapshot, so the relay holds the latest and sends it at
/// the turn boundary. Sequence numbers are the server's idempotency key, so the
/// relay is an actor: two concurrent sends could otherwise interleave and
/// deliver a stale snapshot under a newer sequence.
actor VoiceUsageRelay {
    private let api: NessieVoiceApi
    private let voiceSessionId: String
    private let model: String
    private var sequence = 0
    private var pending: [String: Any]?
    private var finished = false

    init(api: NessieVoiceApi, voiceSessionId: String, model: String) {
        self.api = api
        self.voiceSessionId = voiceSessionId
        self.model = model
    }

    func record(_ metadata: [String: Any]) async {
        guard !finished else { return }
        // Send the previous turn's snapshot as soon as a newer one arrives: a
        // call that dies mid-turn then loses one turn of spend rather than all
        // of it.
        if let previous = pending {
            await send(usage: normalise(previous), complete: false)
        }
        pending = metadata
    }

    /// Closes the Ledger session, carrying the last turn with it.
    func finish() async {
        guard !finished else { return }
        finished = true
        if let last = pending {
            pending = nil
            await send(usage: normalise(last), complete: false)
        }
        // The completion marker is what releases the device's daily
        // reservation; without it the slot is held for the rest of the budget
        // day and the next call on this phone is refused.
        await send(usage: nil, complete: true)
    }

    private func send(usage: [String: Any]?, complete: Bool) async {
        sequence += 1
        do {
            try await api.reportUsage(
                voiceSessionId: voiceSessionId,
                sequence: sequence,
                model: model,
                usage: usage,
                complete: complete
            )
        } catch {
            // Spend nobody can attribute is worse than a diagnostic, but the
            // call must not die over it: the sequence advances either way, so a
            // later report is never mistaken for a replay of this one.
            VoiceLog.failure("usage report \(sequence) not delivered")
        }
    }

    /// Google's usage metadata, in the shape the relay stores.
    private func normalise(_ metadata: [String: Any]) -> [String: Any] {
        func count(_ key: String) -> Int {
            max(0, (metadata[key] as? NSNumber)?.intValue ?? 0)
        }
        func modalities(_ key: String) -> [String: Int] {
            guard let details = metadata[key] as? [[String: Any]] else { return [:] }
            var totals: [String: Int] = [:]
            for detail in details {
                // Keys pass through as Google wrote them: the wire contract
                // says the field names mirror `usageMetadata`, and normalising
                // the case here would be this client reinterpreting a dimension
                // the browser client forwards untouched.
                guard let modality = detail["modality"] as? String else { continue }
                let tokens = max(0, (detail["tokenCount"] as? NSNumber)?.intValue ?? 0)
                totals[modality] = (totals[modality] ?? 0) + tokens
            }
            return totals
        }

        return [
            "promptTokens": count("promptTokenCount"),
            "cachedPromptTokens": count("cachedContentTokenCount"),
            "responseTokens": count("responseTokenCount"),
            "toolUsePromptTokens": count("toolUsePromptTokenCount"),
            "thoughtTokens": count("thoughtsTokenCount"),
            "totalTokens": count("totalTokenCount"),
            "inputModalities": modalities("promptTokensDetails"),
            "cachedModalities": modalities("cacheTokensDetails"),
            "outputModalities": modalities("responseTokensDetails"),
            "toolUsePromptModalities": modalities("toolUsePromptTokensDetails")
        ]
    }
}
