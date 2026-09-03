import Foundation

/// The wire shapes of `packages/schemas/src/voice.ts`, as Swift reads them.
///
/// Decoded rather than treated as loose dictionaries so a contract change
/// fails at the socket rather than three layers in — the browser client gets
/// the same guarantee from zod on the way out.

/// Everything one call needs, from `POST /api/voice/sessions`.
struct VoiceSessionCredential: Decodable {
    let voiceSessionId: String
    let accessToken: String
    let websocketUrl: String
    let model: String
    let expiresAt: String
    let newSessionExpiresAt: String
    let voiceName: String
    let systemInstruction: String
    let seedTurns: [VoiceSeedTurn]
    let functionDeclarations: [JSONValue]
    let limits: VoiceSessionLimits
    let channelId: String
    let threadId: String
    let agentId: String
    let agentName: String
}

/// A fresh Google credential for the *same* call, from `…/rotate`.
struct VoiceSessionRotation: Decodable {
    let voiceSessionId: String
    let accessToken: String
    let websocketUrl: String
    let model: String
    let expiresAt: String
    let newSessionExpiresAt: String
}

struct VoiceSeedTurn: Decodable {
    /// `user` or `model` — Gemini's name for the assistant role.
    let role: String
    let text: String
}

struct VoiceSessionLimits: Decodable {
    let maxDurationMs: Int
    let maxToolCalls: Int
}

struct VoiceDeviceTokenResponse: Decodable {
    let token: String
    let expiresAt: String
    let installationId: String
    let refreshAfter: String
}

struct VoiceToolCallResult: Decodable {
    let result: JSONValue
    let replayed: Bool
}

struct VoiceSendToAssistantResponse: Decodable {
    let messageId: String
    let rootMessageId: String
}

struct VoiceAssistantReply: Decodable {
    let messageId: String
    let text: String
    let createdAt: String
}

struct VoiceAssistantRepliesResponse: Decodable {
    let replies: [VoiceAssistantReply]
}

/// One finalised transcript line, as submitted at call end.
struct VoiceTranscriptLine: Encodable {
    /// `user` or `assistant`.
    let speaker: String
    let text: String
    /// Milliseconds since the call started, not a wall clock.
    let atMs: Int
}

/// The API's `{ data: … }` envelope.
struct ApiEnvelope<T: Decodable>: Decodable {
    let data: T
}

/// A JSON value that survives a round trip without being modelled.
///
/// Tool arguments and tool results are open-ended by design: the declarations
/// come from the server and the results go back to Google verbatim. This lets
/// them pass through Swift's type system without inventing a schema for them.
enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The Foundation representation `JSONSerialization` writes onto the wire.
    var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let value): return value.map(\.foundationValue)
        case .object(let value): return value.mapValues(\.foundationValue)
        }
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}
