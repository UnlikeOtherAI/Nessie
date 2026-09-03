import Foundation

/// Why a call stopped, in the words the person gets.
enum AgentCallEndReason {
    /// The conversation ended on its own — the socket closed for good.
    case remoteEnded
    /// A server-enforced ceiling was reached. Not a failure; say so plainly.
    case limitReached(String)
    case failed(String)

    var message: String? {
        switch self {
        case .remoteEnded: return nil
        case .limitReached(let text): return text
        case .failed(let text): return text
        }
    }
}

/// Conversation lifecycle owned by the *platform's* call framework. Networking
/// and Gemini state stay in the concrete session.
///
/// The seam is deliberately written against the call lifecycle rather than
/// against CallKit: `connect` must not start I/O, and audio starts only when
/// the platform says the call is active. Android's self-managed
/// `ConnectionService` reports the same four moments under different names, so
/// the second platform reuses this protocol and everything behind it —
/// only the audio plumbing and the call framework differ.
///
/// The call target is not a parameter. A Nessie voice call is always with the
/// caller's own Personal Assistant, resolved server-side from the credential,
/// so there is no agent id for a client to name or tamper with.
@MainActor
protocol AgentCallSession: AnyObject {
    var onSessionEnded: ((AgentCallEndReason) -> Void)? { get set }

    /// Obtain the ephemeral credential, open the Gemini socket, and wait until
    /// the setup handshake completes. This must not start audio I/O.
    func connect() async throws

    /// Start I/O after the platform activates the audio session.
    func activateAudio() throws

    /// Stop I/O after the platform deactivates the audio session. The Gemini
    /// socket deliberately stays open so a reactivation continues the same
    /// conversation.
    func deactivateAudio()

    func setInputMuted(_ isMuted: Bool)

    /// The platform put the call on hold — a cellular call arrived, or another
    /// app took the audio. Input stops entirely rather than streaming silence:
    /// silence is a real audio stream Gemini bills for and answers.
    func setHeld(_ isHeld: Bool)

    func disconnectCall() async
}
