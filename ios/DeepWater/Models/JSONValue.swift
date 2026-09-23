import Foundation

/// Flexible envelope for additive server contracts. Feature models validate required fields.
enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    subscript(key: String) -> JSONValue {
        guard case .object(let value) = self else { return .null }
        return value[key] ?? .null
    }
    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }
    var text: String { string ?? "" }
    var array: [JSONValue] {
        if case .array(let value) = self { return value }
        return []
    }
    var object: [String: JSONValue] {
        if case .object(let value) = self { return value }
        return [:]
    }
    var bool: Bool {
        if case .bool(let value) = self { return value }
        return false
    }
    var int: Int {
        if case .number(let value) = self { return Int(exactly: value) ?? 0 }
        return 0
    }

    static func strings(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
}

struct ServiceError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
    static let invalidResponse = ServiceError(
        status: 0, message: "DeepWater returned an unreadable response. Try again.")
}
