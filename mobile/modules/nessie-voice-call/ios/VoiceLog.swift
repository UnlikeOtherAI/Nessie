import OSLog

/// Device diagnostics for a call, shape only.
///
/// Coder's logging discipline, kept verbatim: a call carries the person's own
/// words, tool arguments they dictated, and whatever a tool result contains.
/// None of that belongs in a device log, so every call site passes a
/// description of *what happened* — never a value. The private-by-default
/// interpolation is a second lock on the same door.
enum VoiceLog {
    private static let logger = Logger(subsystem: "works.nessie.voice", category: "call")

    static func shape(_ message: String) {
        logger.debug("\(message, privacy: .public)")
    }

    static func failure(_ message: String) {
        logger.error("\(message, privacy: .public)")
    }
}
