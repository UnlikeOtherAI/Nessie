import SwiftUI

struct Agent: Identifiable, Hashable {
  let id: String
  let name: String
  let type: String
}

struct ChatMessage: Identifiable {
  let id = UUID()
  let role: ChatRole
  let content: String
  let timestamp: Date

  enum ChatRole {
    case user
    case assistant
    case system
  }
}
