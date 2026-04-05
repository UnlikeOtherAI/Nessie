import SwiftUI

// ─── Agent ────────────────────────────────────────────────────────────────────

struct Agent: Identifiable, Hashable {
  let id: String
  let name: String
  let type: String
  let responsibility: String
  let trigger: String
  let intervalMinutes: Int?
}

// ─── Chat message ─────────────────────────────────────────────────────────────

struct ChatMessage: Identifiable, Equatable {
  let id: String
  let role: ChatRole
  let threadId: String
  let content: String
  let timestamp: Date

  enum ChatRole: String, Equatable {
    case user
    case assistant
    case system
  }
}

// ─── Session / thread ─────────────────────────────────────────────────────────

struct Session: Identifiable, Hashable {
  let id: String
  let name: String
  let threadId: String
  let createdAt: Date
  let updatedAt: Date
  let messageCount: Int
  let preview: String
  let agentId: String

  func hash(into hasher: inout Hasher) { hasher.combine(id) }
  static func == (lhs: Session, rhs: Session) -> Bool { lhs.id == rhs.id }
}

// ─── Tool call entry (shown in status panel) ─────────────────────────────────

struct ToolCallEntry: Identifiable {
  let id: String
  let name: String
  let input: [String: String]
  let timestamp: Date
  var doneAt: Date?

  var isDone: Bool { doneAt != nil }
}

// ─── Streaming message (in-progress assistant bubble) ─────────────────────────

struct StreamingMessage: Identifiable {
  let id: String
  let threadId: String
  let content: String
  let startedAt: Date
}
