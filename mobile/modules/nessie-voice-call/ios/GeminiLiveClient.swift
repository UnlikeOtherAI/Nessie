import AVFoundation
import Foundation

/// One Gemini credential, whatever minted it.
struct GeminiCredential {
    let accessToken: String
    let websocketUrl: String
    let model: String
    let expiresAt: Date
}

/// What the server decided this call sounds like and may do.
///
/// All of it comes from `POST /api/voice/sessions`: the voice is the agent's,
/// the instruction is assembled server-side, the declarations are the assembled
/// toolset, and the seed is a role-preserving slice of the DM. Nothing here is
/// a client choice.
struct GeminiSetup {
    let voiceName: String
    let systemInstruction: String
    let functionDeclarations: [Any]
    let seedTurns: [VoiceSeedTurn]
}

/// The Gemini Live protocol client, ported from Coder's iOS implementation.
///
/// Audio flows device↔Google; Nessie is only the broker that minted the
/// credential. The socket lifecycle, the 16 kHz capture / 24 kHz playback
/// pipeline, session resumption, credential rotation and per-turn usage
/// snapshots are the parts worth taking verbatim — the credential source is
/// what changed, from Ledger directly to the Nessie voice routes.
final class GeminiLiveClient: NSObject, URLSessionWebSocketDelegate {
    enum Event {
        case connected
        case status(String)
        case userTranscript(String)
        case assistantTranscript(String)
        case modelSpeakingChanged(Bool)
        case turnComplete
        case usage([String: Any])
        case failed(String)
        case disconnected
    }

    /// Mints the next credential. Called at connect and again at each rotation,
    /// so the client never learns where credentials come from.
    typealias CredentialProvider = (_ isRotation: Bool) async throws -> GeminiCredential
    /// Executes one tool call and answers with the value sent back to Gemini.
    /// The provider's call id travels with it: the server claims
    /// `(voiceSessionId, providerCallId)` so a retried call replays its cached
    /// result instead of running twice.
    typealias ToolHandler = (
        _ providerCallId: String,
        _ name: String,
        _ arguments: [String: Any]
    ) async -> Any

    let setup: GeminiSetup
    let credentialProvider: CredentialProvider
    let toolHandler: ToolHandler
    var onEvent: ((Event) -> Void)?

    // Socket state, guarded by `messageStateLock`.
    let messageStateLock = NSLock()
    var socketTask: URLSessionWebSocketTask?
    var urlSession: URLSession?
    var liveModel = ""
    var accessToken = ""
    var websocketUrl = ""
    var credentialExpiresAt: Date?
    var sessionResumptionHandle: String?
    var reconnectTask: Task<Void, Never>?
    var credentialRotationTask: Task<Void, Never>?
    var reconnectAttempt = 0
    var isRotatingCredential = false
    var isStopping = false
    var didNotifyDisconnected = false
    var didNotifyConnected = false
    var didSeedContext = false
    var isSocketOpen = false
    var isReadyForRealtimeInput = false
    var isModelSpeaking = false

    // Audio state.
    let audioEngine = AVAudioEngine()
    let playbackEngine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
    /// Gemini answers at 24 kHz mono PCM16, and the capture side sends 16 kHz.
    /// Both are ordinary linear-PCM descriptions `AVAudioFormat` always builds,
    /// so this is a constant rather than a value that can fail — but it is
    /// written as a fallible lookup so a typo becomes a nil format the pipeline
    /// refuses, not a launch-time crash.
    static let playbackFormat = pcm16Format(sampleRate: 24_000)
    static let captureFormat = pcm16Format(sampleRate: 16_000)

    static func pcm16Format(sampleRate: Double) -> AVAudioFormat? {
        AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true
        )
    }

    let playerFormat = GeminiLiveClient.playbackFormat
    var inputConverter: AVAudioConverter?
    var isAudioActive = false
    var isCapturing = false
    var isInputMuted = false
    var isHeld = false
    var routeChangeObserver: NSObjectProtocol?
    var engineConfigurationObserver: NSObjectProtocol?

    init(
        setup: GeminiSetup,
        credentialProvider: @escaping CredentialProvider,
        toolHandler: @escaping ToolHandler
    ) {
        self.setup = setup
        self.credentialProvider = credentialProvider
        self.toolHandler = toolHandler
        super.init()
    }

    /// Opens the socket and waits for `setupComplete`.
    ///
    /// Deliberately does **not** start audio: CallKit owns the audio session,
    /// and it activates one only after the call itself is connected. Starting
    /// capture here would fight the system for a session it has not handed over.
    func connect(onEvent: @escaping (Event) -> Void) async throws {
        self.onEvent = onEvent
        resetForConnect()

        let credential = try await credentialProvider(false)
        guard !isStopping else { throw CancellationError() }
        apply(credential)
        observeAudioRouteChanges()
        connectWebSocket(accessToken: credential.accessToken)
        scheduleCredentialRotation()

        // Google answers `setupComplete` within a second on a healthy socket;
        // a socket that opens and then says nothing is the binary-frame class of
        // bug, which must fail loudly rather than sit on "Connecting…".
        let deadline = Date().addingTimeInterval(20)
        while !isReadyForRealtimeInput, !isStopping, Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard isReadyForRealtimeInput else {
            throw GeminiLiveError.setupTimedOut
        }
    }

    func stop() async {
        let (taskToCancel, sessionToCancel) = messageStateLock.withLock {
            isStopping = true
            let task = socketTask
            socketTask = nil
            let session = urlSession
            urlSession = nil
            return (task, session)
        }

        reconnectTask?.cancel()
        reconnectTask = nil
        credentialRotationTask?.cancel()
        credentialRotationTask = nil
        isRotatingCredential = false
        stopObservingAudioRouteChanges()
        stopAudioEngines()
        isSocketOpen = false
        isReadyForRealtimeInput = false
        isModelSpeaking = false
        taskToCancel?.cancel(with: .goingAway, reason: nil)
        sessionToCancel?.invalidateAndCancel()
        accessToken = ""
        credentialExpiresAt = nil
        sessionResumptionHandle = nil
        if !didNotifyDisconnected {
            didNotifyDisconnected = true
            onEvent?(.disconnected)
        }
    }

    /// Starts I/O after CallKit activates its `AVAudioSession`.
    func activateAudio() throws {
        guard !isStopping, !isAudioActive else { return }
        isAudioActive = true
        do {
            try startPlayback()
            if isReadyForRealtimeInput {
                try startCapture()
            }
        } catch {
            stopAudioEngines()
            throw error
        }
    }

    /// Stops I/O but leaves the socket connected, so a CallKit reactivation
    /// continues the same conversation rather than starting a second one.
    func deactivateAudio() {
        stopAudioEngines()
    }

    func setInputMuted(_ isMuted: Bool) {
        isInputMuted = isMuted
    }

    /// The platform took the call. Input stops entirely — see `send(buffer:)`
    /// for why this is not the same as muting.
    func setHeld(_ held: Bool) {
        guard isHeld != held else { return }
        isHeld = held
        if held {
            isModelSpeaking = false
            playerNode.stop()
            playerNode.play()
        }
        emitStatus(held ? "Call on hold" : "Call resumed")
    }

    /// Speaks a line the app produced rather than the person — an assistant
    /// reply that arrived after a hand-off, read out in the model's own voice.
    func speak(_ text: String) {
        guard isSocketOpen else { return }
        sendRealtimeInput(["text": text])
    }

    private func resetForConnect() {
        isAudioActive = false
        isCapturing = false
        didNotifyConnected = false
        didNotifyDisconnected = false
        didSeedContext = false
        isSocketOpen = false
        isReadyForRealtimeInput = false
        isModelSpeaking = false
        isHeld = false
        accessToken = ""
        credentialExpiresAt = nil
        sessionResumptionHandle = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        credentialRotationTask?.cancel()
        credentialRotationTask = nil
        reconnectAttempt = 0
        isRotatingCredential = false
        isStopping = false
    }

    func apply(_ credential: GeminiCredential) {
        accessToken = credential.accessToken
        websocketUrl = credential.websocketUrl
        credentialExpiresAt = credential.expiresAt
        liveModel = credential.model.hasPrefix("models/")
            ? credential.model
            : "models/\(credential.model)"
    }
}

enum GeminiLiveError: LocalizedError {
    case setupTimedOut
    case noMicrophoneInput
    case audioFormatUnavailable

    var errorDescription: String? {
        switch self {
        case .setupTimedOut:
            return "The voice service did not finish connecting."
        case .noMicrophoneInput:
            return "No microphone input is available."
        case .audioFormatUnavailable:
            return "This device could not open the call's audio format."
        }
    }
}
