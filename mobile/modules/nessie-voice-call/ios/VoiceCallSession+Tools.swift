import Foundation

extension VoiceCallSession {
    /// Answers one tool call.
    ///
    /// Everything except the hand-off runs server-side, so the model never
    /// holds a credential and cannot reach anything the person could not.
    /// `pa_send` is the exception only in *where* it posts — through its own
    /// voice-scoped route, because the device credential is deliberately not
    /// accepted on the generic message routes.
    func runTool(providerCallId: String, name: String, arguments: [String: Any]) async -> Any {
        guard let session = credential else {
            return ["ok": false, "error": "The call is not connected."]
        }

        if name == "pa_send" {
            let text = (arguments["text"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let text, !text.isEmpty else {
                return ["ok": false, "error": "No request text was provided."]
            }
            return await dispatchHandoff(text, providerCallId: providerCallId)
        }

        guard claimToolCall(limit: session.limits.maxToolCalls) else {
            return ["ok": false, "error": "This call has used all of its tool calls."]
        }

        do {
            let answer = try await api.runTool(
                voiceSessionId: session.voiceSessionId,
                providerCallId: providerCallId,
                name: name,
                args: arguments
            )
            return answer.result.foundationValue
        } catch let error as NessieVoiceApiError {
            if case .http(let status, _, _) = error, status == 429 {
                return ["ok": false, "error": "This call has used all of its tool calls."]
            }
            VoiceLog.failure("tool \(name) failed")
            return ["ok": false, "error": "That did not work. Say so and carry on."]
        } catch {
            VoiceLog.failure("tool \(name) failed")
            return ["ok": false, "error": "That did not work. Say so and carry on."]
        }
    }

    private func dispatchHandoff(_ text: String, providerCallId: String) async -> Any {
        guard let handoff else {
            return ["ok": false, "error": "Hand-off is unavailable on this call."]
        }
        do {
            // Gemini Live blocks the conversation until a tool responds, and a
            // real run takes far longer than a person will wait — so the ack is
            // immediate and the answer arrives later as its own spoken turn.
            try await handoff.dispatch(text, providerCallId: providerCallId) { [weak self] reply in
                Task { @MainActor [weak self] in self?.speak(reply) }
            }
            return ["ok": true, "status": "working"]
        } catch let error as NessieVoiceApiError {
            // A hand-off spends from the same per-call tool budget the relay
            // enforces, so the model hears the same sentence it would for any
            // other tool that ran out.
            if case .http(let status, _, _) = error, status == 429 {
                return ["ok": false, "error": "This call has used all of its tool calls."]
            }
            return ["ok": false, "error": "That could not be handed over. Say so and carry on."]
        } catch {
            return ["ok": false, "error": "That could not be handed over. Say so and carry on."]
        }
    }
}

/// Hands work to the assistant's own longer-running self, and waits for it.
///
/// Polling rather than the thread SSE stream: a run that consumed a privileged
/// source has its live lane cut structurally, so the stream can silently never
/// deliver. A viewer-entitled read always answers correctly — with the reply if
/// the caller may see it, without it if not.
actor VoiceAssistantHandoff {
    private let api: NessieVoiceApi
    private let voiceSessionId: String
    private var watchers: [Task<Void, Never>] = []
    private var stopped = false

    /// Long enough for a real run, short enough that a stuck one does not leave
    /// a poll running for the rest of the call.
    private let pollWindow: TimeInterval = 300
    private let pollInterval: UInt64 = 3_000_000_000

    init(api: NessieVoiceApi, voiceSessionId: String) {
        self.api = api
        self.voiceSessionId = voiceSessionId
    }

    func dispatch(
        _ text: String,
        providerCallId: String,
        onReply: @escaping @Sendable (String) -> Void
    ) async throws {
        guard !stopped else { return }
        let sent = try await api.sendToAssistant(
            voiceSessionId: voiceSessionId,
            providerCallId: providerCallId,
            text: text
        )
        let watcher = Task { [weak self] in
            guard let self else { return }
            await self.watch(after: sent.messageId, onReply: onReply)
        }
        watchers.append(watcher)
    }

    func stop() {
        stopped = true
        for watcher in watchers { watcher.cancel() }
        watchers.removeAll()
    }

    private func watch(after messageId: String, onReply: @escaping @Sendable (String) -> Void) async {
        let deadline = Date().addingTimeInterval(pollWindow)
        var cursor = messageId
        while !Task.isCancelled, !stopped, Date() < deadline {
            try? await Task.sleep(nanoseconds: pollInterval)
            guard !Task.isCancelled, !stopped else { return }
            guard let page = try? await api.repliesAfter(
                voiceSessionId: voiceSessionId,
                messageId: cursor
            ), !page.replies.isEmpty else {
                continue
            }
            for reply in page.replies where !reply.text.isEmpty {
                onReply(reply.text)
            }
            cursor = page.replies[page.replies.count - 1].messageId
            return
        }
    }
}
