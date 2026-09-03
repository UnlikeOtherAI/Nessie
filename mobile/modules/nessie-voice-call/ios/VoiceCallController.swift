import Foundation

/// What the JS side sees of a call.
struct VoiceCallSnapshot {
    var phase: String
    var muted: Bool
    var error: String?
    var agentName: String?
    var startedAt: Double?
    var liveAssistantText: String
    var assistantSpeaking: Bool

    static let idle = VoiceCallSnapshot(
        phase: "idle",
        muted: false,
        error: nil,
        agentName: nil,
        startedAt: nil,
        liveAssistantText: "",
        assistantSpeaking: false
    )

    var dictionary: [String: Any] {
        [
            "phase": phase,
            "muted": muted,
            "error": error as Any? ?? NSNull(),
            "agentName": agentName as Any? ?? NSNull(),
            "startedAt": startedAt as Any? ?? NSNull(),
            "liveAssistantText": liveAssistantText,
            "assistantSpeaking": assistantSpeaking
        ]
    }
}

/// The last published snapshot, readable off the main actor.
///
/// `getActiveCallState()` answers the shell's very first render, so it cannot
/// be asynchronous and must not block on the main queue — which is the queue
/// doing the rendering.
final class VoiceCallSnapshotBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Any] = VoiceCallSnapshot.idle.dictionary

    func read() -> [String: Any] { lock.withLock { value } }
    func write(_ next: [String: Any]) { lock.withLock { value = next } }
}

/// Deliberately outside the main-actor-isolated controller: the whole point of
/// the box is that it can be read from whichever thread asks.
private let latestVoiceCallSnapshot = VoiceCallSnapshotBox()

/// The call, owned by the process rather than by the Expo module instance.
///
/// This is what makes rehydration possible. A JS reload tears down the module
/// and every listener with it, but the CallKit call, the socket and the
/// microphone are all still running — so the call lives on a singleton the next
/// module instance can ask, rather than in the module that happened to start it.
@MainActor
final class VoiceCallController {
    static let shared = VoiceCallController()

    /// Set by whichever module instance is currently alive.
    var onSnapshot: ((VoiceCallSnapshot) -> Void)?

    /// The state a freshly loaded JS bundle reads before it can subscribe.
    nonisolated static var currentSnapshot: [String: Any] { latestVoiceCallSnapshot.read() }

    private var coordinator: AgentCallCoordinator?
    private var session: VoiceCallSession?

    private init() {}

    func start(provisioning: [String: Any]) async throws {
        guard let credential = Self.credential(from: provisioning) else {
            throw NessieVoiceApiError.notProvisioned
        }
        // The WebView is the *initial* provisioning path only: from here the
        // native side renews the credential itself, because a locked phone has
        // no foreground WebView to ask.
        guard coordinator == nil else {
            throw AgentCallCoordinator.CoordinatorError.callAlreadyActive
        }

        let agentName = provisioning["agentName"] as? String ?? "Personal Assistant"
        let api = NessieVoiceApi(credential: credential)
        let session = VoiceCallSession(api: api, agentName: agentName)
        let coordinator = AgentCallCoordinator(session: session)
        session.onChange = { [weak self] in self?.publish() }
        coordinator.onChange = { [weak self] in self?.publish() }
        self.session = session
        self.coordinator = coordinator

        do {
            try await coordinator.call(displayName: agentName)
        } catch {
            teardown()
            throw error
        }
    }

    func end() async {
        try? await coordinator?.endCall()
    }

    func setMuted(_ muted: Bool) async {
        try? await coordinator?.setMuted(muted)
    }

    func snapshot() -> VoiceCallSnapshot {
        guard let coordinator, let session else { return .idle }
        let phase: String
        switch coordinator.state {
        case .idle: phase = coordinator.lastError == nil ? "idle" : "failed"
        case .requesting, .connecting: phase = "connecting"
        case .active: phase = "live"
        case .held: phase = "held"
        case .ending: phase = "ending"
        }
        return VoiceCallSnapshot(
            phase: phase,
            muted: coordinator.isMuted,
            error: coordinator.lastError,
            agentName: session.agentName ?? coordinator.displayName,
            startedAt: session.startedAt.map { $0.timeIntervalSince1970 * 1_000 },
            liveAssistantText: session.liveAssistantText,
            assistantSpeaking: session.assistantSpeaking
        )
    }

    private func publish() {
        let snapshot = snapshot()
        latestVoiceCallSnapshot.write(snapshot.dictionary)
        onSnapshot?(snapshot)
        // The call is over and reported; drop the objects so the next call
        // starts clean rather than inheriting a finished coordinator.
        if snapshot.phase == "idle" || snapshot.phase == "failed" {
            teardown()
        }
    }

    private func teardown() {
        // The failure has already gone out as an event by the time this runs.
        // What a *later* reader must see is that there is no call, so the box
        // goes back to idle rather than keeping a stale error alive.
        latestVoiceCallSnapshot.write(VoiceCallSnapshot.idle.dictionary)
        session?.onChange = nil
        coordinator?.onChange = nil
        session = nil
        coordinator = nil
    }

    private static func credential(from provisioning: [String: Any]) -> VoiceDeviceCredential? {
        guard let token = provisioning["token"] as? String,
              let installationId = provisioning["installationId"] as? String,
              let apiBaseUrl = provisioning["apiBaseUrl"] as? String,
              let expiresAt = (provisioning["tokenExpiresAt"] as? String).flatMap(VoiceDate.parse),
              let refreshAfter = (provisioning["refreshAfter"] as? String).flatMap(VoiceDate.parse)
        else {
            return nil
        }
        return VoiceDeviceCredential(
            token: token,
            expiresAt: expiresAt,
            refreshAfter: refreshAfter,
            installationId: installationId,
            apiBaseUrl: apiBaseUrl.hasSuffix("/") ? String(apiBaseUrl.dropLast()) : apiBaseUrl
        )
    }
}
