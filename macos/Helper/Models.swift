import SwiftUI

struct Agent: Identifiable, Hashable {
  let id: String
  let name: String
  let type: String
}

struct ChatMessage: Identifiable, Equatable {
  let id = UUID()
  let role: ChatRole
  let content: String
  let timestamp: Date

  enum ChatRole: Equatable {
    case user
    case assistant
    case system
  }
}
