import AVFoundation
import CallKit
import Foundation

/// Owns the single system call Nessie advertises. Gemini owns conversation
/// state; CallKit owns the call lifecycle and `AVAudioSession` activation.
///
/// Ported from Coder's coordinator, with one addition the reference did not
/// need: `CXSetHeldCallAction`. A cellular call arriving mid-call is the most
/// routine way a voice call dies, and without handling hold the agent call
/// keeps streaming into an audio session iOS has taken away.
@MainActor
final class AgentCallCoordinator: NSObject {
    enum CallState: String, Sendable {
        case idle
        case requesting
        case connecting
        case active
        case held
        case ending
    }

    enum CoordinatorError: LocalizedError {
        case callAlreadyActive
        case noActiveCall

        var errorDescription: String? {
            switch self {
            case .callAlreadyActive: return "A call is already in progress."
            case .noActiveCall: return "There is no call in progress."
            }
        }
    }

    private(set) var state: CallState = .idle
    private(set) var isMuted = false
    private(set) var lastError: String?
    private(set) var displayName = "Personal Assistant"

    /// Fired on every state transition, so the JS side can mirror it.
    var onChange: (() -> Void)?

    var hasCall: Bool { state != .idle }

    private let provider: CXProvider
    private let callController: CXCallController
    private let session: AgentCallSession
    private var activeCallID: UUID?

    init(session: AgentCallSession) {
        self.session = session

        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        // Redial from the system Recents list is one of Rule zero's doorways.
        configuration.includesCallsInRecents = true

        provider = CXProvider(configuration: configuration)
        callController = CXCallController()
        super.init()

        provider.setDelegate(self, queue: .main)
        session.onSessionEnded = { [weak self] reason in
            self?.endCurrentCall(reason: reason)
        }
    }

    func call(displayName: String) async throws {
        guard !hasCall else { throw CoordinatorError.callAlreadyActive }

        let callID = UUID()
        activeCallID = callID
        self.displayName = displayName
        isMuted = false
        lastError = nil
        publish(.requesting)

        let handle = CXHandle(type: .generic, value: displayName)
        let action = CXStartCallAction(call: callID, handle: handle)
        action.isVideo = false

        do {
            try await request(CXTransaction(action: action))
        } catch {
            clearCallState(error: error.localizedDescription)
            throw error
        }
    }

    func endCall() async throws {
        guard let activeCallID else { throw CoordinatorError.noActiveCall }
        publish(.ending)
        try await request(CXTransaction(action: CXEndCallAction(call: activeCallID)))
    }

    func setMuted(_ muted: Bool) async throws {
        guard let activeCallID else { throw CoordinatorError.noActiveCall }
        try await request(
            CXTransaction(action: CXSetMutedCallAction(call: activeCallID, muted: muted))
        )
    }

    private func request(_ transaction: CXTransaction) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            callController.request(transaction) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func endCurrentCall(reason: AgentCallEndReason) {
        guard state != .ending, let callID = activeCallID else { return }
        let cxReason: CXCallEndedReason
        switch reason {
        case .remoteEnded: cxReason = .remoteEnded
        case .limitReached: cxReason = .remoteEnded
        case .failed: cxReason = .failed
        }
        provider.reportCall(with: callID, endedAt: Date(), reason: cxReason)
        publish(.ending)
        session.deactivateAudio()
        Task { [weak self] in
            guard let self else { return }
            await self.session.disconnectCall()
            self.clearCallState(error: reason.message)
        }
    }

    private func clearCallState(error: String? = nil) {
        activeCallID = nil
        isMuted = false
        lastError = error
        publish(.idle)
    }

    private func publish(_ next: CallState) {
        state = next
        onChange?()
    }
}

extension AgentCallCoordinator: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.session.deactivateAudio()
            await self.session.disconnectCall()
            self.clearCallState()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor [weak self] in
            guard let self, action.callUUID == self.activeCallID else {
                action.fail()
                return
            }

            self.publish(.connecting)
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())

            do {
                try await self.session.connect()
                guard action.callUUID == self.activeCallID, self.state != .ending else {
                    action.fail()
                    await self.session.disconnectCall()
                    return
                }
                provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
                self.publish(.active)
                action.fulfill()
            } catch {
                guard action.callUUID == self.activeCallID, self.state != .ending else {
                    action.fail()
                    return
                }
                self.lastError = error.localizedDescription
                action.fail()
                provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
                await self.session.disconnectCall()
                self.clearCallState(error: error.localizedDescription)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor [weak self] in
            guard let self, action.callUUID == self.activeCallID else {
                action.fail()
                return
            }
            self.publish(.ending)
            self.session.deactivateAudio()
            action.fulfill()
            await self.session.disconnectCall()
            self.clearCallState()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor [weak self] in
            guard let self, action.callUUID == self.activeCallID else {
                action.fail()
                return
            }
            self.session.setInputMuted(action.isMuted)
            self.isMuted = action.isMuted
            self.onChange?()
            action.fulfill()
        }
    }

    /// A cellular call arrived and the person answered it, or they put us on
    /// hold from the system UI. iOS takes the audio session either way; what it
    /// does not do is stop our socket, so without this the call would keep
    /// streaming captured silence into billed turns and answer aloud into an
    /// output nobody can hear.
    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        Task { @MainActor [weak self] in
            guard let self, action.callUUID == self.activeCallID else {
                action.fail()
                return
            }
            self.session.setHeld(action.isOnHold)
            if action.isOnHold {
                self.publish(.held)
            } else if self.state == .held {
                self.publish(.active)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor [weak self] in
            guard let self, self.hasCall, self.state != .ending else { return }
            do {
                try self.session.activateAudio()
                // A mute request can arrive before CallKit activates audio.
                // Reapply the current state so activation never unmutes input.
                self.session.setInputMuted(self.isMuted)
                // Coming back from a held call: audio is ours again.
                self.session.setHeld(false)
                if self.state == .held { self.publish(.active) }
            } catch {
                self.lastError = error.localizedDescription
                self.endCurrentCall(reason: .failed(error.localizedDescription))
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Deactivation without an end action means something took the
            // audio. Stop I/O, keep the socket, and stop sending: the hold
            // action may or may not follow, and either way no captured audio
            // should reach a turn we would be billed for.
            self.session.setHeld(true)
            self.session.deactivateAudio()
        }
    }
}
