import Foundation

/// Accumulates the spoken turns of one call.
///
/// The lines exist only on this device — only the client heard the audio — so
/// they are the one artefact of a call nothing else can reconstruct. They are
/// finalised at each turn boundary and submitted once at the end.
final class VoiceTranscriptCollector {
    private(set) var lines: [VoiceTranscriptLine] = []
    private var pendingUser = ""
    private var pendingAssistant = ""

    var liveAssistantText: String { pendingAssistant }

    func appendUser(_ text: String) {
        pendingUser += text
    }

    func appendAssistant(_ text: String) {
        pendingAssistant += text
    }

    /// Closes whatever is buffered into ordered lines.
    ///
    /// The person speaks before the assistant answers, so the user line is
    /// written first regardless of which chunk arrived last — transcription of
    /// the two directions interleaves on the wire. `atMs` is milliseconds since
    /// the call started, which is what the record renders; a wall clock would
    /// leak nothing useful and read wrong across a time-zone change mid-call.
    func finalise(atMs: Int) {
        let clamped = max(0, atMs)
        let user = pendingUser.trimmingCharacters(in: .whitespacesAndNewlines)
        if !user.isEmpty {
            lines.append(VoiceTranscriptLine(speaker: "user", text: clamp(user), atMs: clamped))
        }
        let assistant = pendingAssistant.trimmingCharacters(in: .whitespacesAndNewlines)
        if !assistant.isEmpty {
            lines.append(
                VoiceTranscriptLine(speaker: "assistant", text: clamp(assistant), atMs: clamped)
            )
        }
        pendingUser = ""
        pendingAssistant = ""
    }

    /// The wire caps a line at 4,000 characters. A monologue longer than that
    /// is one turn, so truncating here keeps the whole submission valid rather
    /// than having the server reject the entire transcript over one line.
    private func clamp(_ text: String) -> String {
        text.count <= 4_000 ? text : String(text.prefix(4_000))
    }
}
