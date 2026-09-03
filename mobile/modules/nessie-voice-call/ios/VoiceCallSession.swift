import AVFoundation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// One Nessie voice call, on the platform side of the seam.
///
/// CallKit owns the call and the audio session; this owns the credential, the
/// Gemini socket, the usage relay and the transcript. `connect()` deliberately
/// starts no I/O — audio begins only when the platform says the call is active,
/// which is the property that lets Android reuse everything here unchanged.
@MainActor
final class VoiceCallSession: AgentCallSession {
    var onSessionEnded: ((AgentCallEndReason) -> Void)?
    /// Fired on every observable change, so the JS side can mirror it.
    var onChange: (() -> Void)?

    private(set) var agentName: String?
    private(set) var startedAt: Date?
    private(set) var liveAssistantText = ""
    private(set) var assistantSpeaking = false

    /// Reachable from the tools extension, which lives in its own file.
    let api: NessieVoiceApi
    private(set) var credential: VoiceSessionCredential?
    private(set) var handoff: VoiceAssistantHandoff?
    private var client: GeminiLiveClient?
    private let collector = VoiceTranscriptCollector()
    private var usage: VoiceUsageRelay?
    private var durationCapTask: Task<Void, Never>?
    private var toolCallCount = 0
    private var isTearingDown = false
    /// The platform activated audio before there was anything to activate.
    private var missedAudioActivation = false
    /// Chains usage snapshots so they reach the relay in the order Google sent
    /// them. Independent tasks are not ordered, and the relay stamps a sequence
    /// number at send time — so unchained, a later snapshot can be filed under
    /// an earlier sequence and the server would treat the older one as a replay.
    private var usageChain: Task<Void, Never>?

    init(api: NessieVoiceApi, agentName: String?) {
        self.api = api
        self.agentName = agentName
    }

    // MARK: - AgentCallSession

    func connect() async throws {
        // Prove the local audio path before minting. The Gemini credential is
        // one-use and holds a daily budget reservation, so an audio failure
        // after minting wastes one until it expires.
        try GeminiLiveClient.configureAudioSession()
        guard await GeminiLiveClient.requestMicrophoneAccess() else {
            throw VoiceCallError.microphoneDenied
        }

        let session = try await api.startSession()
        credential = session
        agentName = session.agentName
        onChange?()

        let relay = VoiceUsageRelay(api: api, voiceSessionId: session.voiceSessionId, model: session.model)
        usage = relay
        handoff = VoiceAssistantHandoff(api: api, voiceSessionId: session.voiceSessionId)

        let live = GeminiLiveClient(
            setup: GeminiSetup(
                voiceName: session.voiceName,
                systemInstruction: session.systemInstruction,
                functionDeclarations: session.functionDeclarations.map(\.foundationValue),
                seedTurns: session.seedTurns
            ),
            credentialProvider: { [weak self] isRotation in
                guard let self else { throw CancellationError() }
                return try await self.mintCredential(isRotation: isRotation)
            },
            toolHandler: { [weak self] providerCallId, name, arguments in
                guard let self else { return ["ok": false, "error": "The call ended."] }
                return await self.runTool(
                    providerCallId: providerCallId,
                    name: name,
                    arguments: arguments
                )
            }
        )
        client = live

        try await live.connect { [weak self] event in
            Task { @MainActor [weak self] in self?.handle(event) }
        }

        startedAt = Date()
        if missedAudioActivation {
            missedAudioActivation = false
            try live.activateAudio()
        }
        scheduleDurationCap(session.limits.maxDurationMs)
        onChange?()
    }

    func activateAudio() throws {
        guard let client else {
            // `connect()` runs a permission prompt and a network round trip
            // before the client exists, and `didActivate` is the only caller
            // of this. Dropping it there would leave a connected call with no
            // audio in either direction and nothing to re-arm it.
            missedAudioActivation = true
            return
        }
        try client.activateAudio()
    }

    func deactivateAudio() {
        client?.deactivateAudio()
    }

    func setInputMuted(_ isMuted: Bool) {
        client?.setInputMuted(isMuted)
    }

    func setHeld(_ isHeld: Bool) {
        client?.setHeld(isHeld)
    }

    func disconnectCall() async {
        guard !isTearingDown else { return }
        isTearingDown = true
        // The call is over, so the audio background mode that kept this process
        // alive is gone the moment CallKit lets go — and the transcript still
        // has to be delivered. It is the one artefact of a call nothing else
        // can reconstruct: only the client heard the audio. This buys the few
        // seconds the final usage report and the record need.
        let backgroundTask = beginBackgroundWork()
        defer { endBackgroundWork(backgroundTask) }
        // Stopping the client emits `.disconnected`, which is the same signal
        // an unexpected drop sends. Left wired, that re-enters the coordinator
        // during its own teardown: a second `reportCall(endedAt:)` on a call
        // already reported, and a `clearCallState(error: nil)` that wipes the
        // real failure reason before it reaches anyone.
        onSessionEnded = nil
        durationCapTask?.cancel()
        durationCapTask = nil
        await handoff?.stop()
        handoff = nil

        let elapsed = elapsedMs()
        collector.finalise(atMs: elapsed)
        await client?.stop()
        client = nil

        if let session = credential {
            // Drain what is queued before closing the Ledger session, or the
            // completion marker races the last turn's spend.
            await usageChain?.value
            usageChain = nil
            await usage?.finish()
            await submitRecord(session: session, durationMs: elapsed)
        }
        usage = nil
        credential = nil
        startedAt = nil
        liveAssistantText = ""
        assistantSpeaking = false
        toolCallCount = 0
        missedAudioActivation = false
        isTearingDown = false
        onChange?()
    }

    // MARK: - Internals

    private func mintCredential(isRotation: Bool) async throws -> GeminiCredential {
        guard let session = credential else { throw NessieVoiceApiError.notProvisioned }
        if !isRotation {
            return GeminiCredential(
                accessToken: session.accessToken,
                websocketUrl: session.websocketUrl,
                model: session.model,
                expiresAt: VoiceDate.parse(session.expiresAt) ?? Date().addingTimeInterval(1_800)
            )
        }
        // One call is one voice session across N Google credentials, so
        // rotation keeps the usage stream and the single transcript slot
        // attached to this call rather than starting a second one.
        let rotated = try await api.rotateSession(session.voiceSessionId)
        return GeminiCredential(
            accessToken: rotated.accessToken,
            websocketUrl: rotated.websocketUrl,
            model: rotated.model,
            expiresAt: VoiceDate.parse(rotated.expiresAt) ?? Date().addingTimeInterval(1_800)
        )
    }

    private func handle(_ event: GeminiLiveClient.Event) {
        switch event {
        case .connected, .status:
            break
        case .userTranscript(let text):
            collector.appendUser(text)
        case .assistantTranscript(let text):
            collector.appendAssistant(text)
            liveAssistantText = collector.liveAssistantText
            onChange?()
        case .modelSpeakingChanged(let speaking):
            assistantSpeaking = speaking
            onChange?()
        case .turnComplete:
            collector.finalise(atMs: elapsedMs())
            liveAssistantText = ""
            onChange?()
        case .usage(let metadata):
            let relay = usage
            let previous = usageChain
            usageChain = Task {
                await previous?.value
                await relay?.record(metadata)
            }
        case .failed(let message):
            onSessionEnded?(.failed(message))
        case .disconnected:
            // A socket that closed for good after the call was up is the
            // conversation ending, not a failure to report as one.
            onSessionEnded?(.remoteEnded)
        }
    }

    /// Ends the call at the server's own ceiling rather than letting the next
    /// request fail with it.
    ///
    /// On a default deployment this is 30 minutes — the same lifetime as
    /// Google's credential, so a default-configured locked-phone call reaches
    /// its cap before it would ever need to rotate.
    private func scheduleDurationCap(_ maxDurationMs: Int) {
        durationCapTask?.cancel()
        let seconds = Double(maxDurationMs) / 1_000
        durationCapTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.onSessionEnded?(
                    .limitReached("The call reached this workspace's length limit.")
                )
            }
        }
    }

    private func submitRecord(session: VoiceSessionCredential, durationMs: Int) async {
        let lines = collector.lines
        do {
            if lines.isEmpty {
                try await api.endSession(session.voiceSessionId)
            } else {
                try await api.submitTranscript(
                    voiceSessionId: session.voiceSessionId,
                    lines: lines,
                    durationMs: durationMs
                )
            }
        } catch {
            // The call is over either way. A record that could not be written
            // is worth a diagnostic, never holding the hang-up.
            VoiceLog.failure("call record not written: \(error.localizedDescription)")
        }
    }

    /// Claims one of the call's tool-call budget, or refuses.
    ///
    /// The relay enforces the same ceiling; refusing here means the model hears
    /// a sentence it can say aloud rather than an opaque failure on every turn
    /// after the budget is gone.
    func claimToolCall(limit: Int) -> Bool {
        guard toolCallCount < limit else { return false }
        toolCallCount += 1
        return true
    }

    /// Reads out a line the app produced rather than the person — an assistant
    /// reply that arrived after a hand-off, in the model's own voice.
    func speak(_ text: String) {
        client?.speak(text)
    }

#if canImport(UIKit)
    private func beginBackgroundWork() -> UIBackgroundTaskIdentifier {
        UIApplication.shared.beginBackgroundTask(withName: "nessie.voice.call-record")
    }

    private func endBackgroundWork(_ identifier: UIBackgroundTaskIdentifier) {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
    }
#else
    private func beginBackgroundWork() -> Int { 0 }
    private func endBackgroundWork(_ identifier: Int) {}
#endif

    private func elapsedMs() -> Int {
        guard let startedAt else { return 0 }
        return max(0, Int(Date().timeIntervalSince(startedAt) * 1_000))
    }
}

enum VoiceCallError: LocalizedError {
    case microphoneDenied

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "Nessie needs the microphone to call your assistant. "
                + "Turn it on in Settings › Nessie."
        }
    }
}
