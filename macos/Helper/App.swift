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
  @StateObject private var _networkMonitor = NetworkMonitor()

  var networkMonitor: NetworkMonitor { _networkMonitor }

  init() {
    // Observe network changes via NotificationCenter
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("NetworkStatusChanged"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.isOnline = self?._networkMonitor.isConnected ?? false
    }
  }
}
