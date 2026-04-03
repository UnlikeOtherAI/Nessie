import SwiftUI

@main
struct HelperApp: App {
  @StateObject private var appState = AppState()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(appState)
    }
  }
}

class AppState: ObservableObject {
  @Published var isOnline = true
  @Published var isListening = false
  @Published var isSpeaking = false
  @Published var selectedAgent: Agent = Agent(id: "main", name: "Helper", type: "orchestrator")
  @Published var agents: [Agent] = [
    Agent(id: "main", name: "Helper", type: "orchestrator")
  ]
  @Published var messages: [ChatMessage] = []
  @Published var hotwordReady = true
  @ObservedObject var networkMonitor = NetworkMonitor()

  init() {
    // Observe network changes
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("NetworkStatusChanged"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.isOnline = self?.networkMonitor.isConnected ?? false
    }
  }
}

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
