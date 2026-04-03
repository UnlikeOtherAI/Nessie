import SwiftUI

#if DEBUG
import AppReveal
#endif

@main
struct HelperApp: App {
  @StateObject private var appState = AppState()
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(appState)
    }
  }
}

// AppReveal integration — starts the MCP server for testing in DEBUG builds
class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    #if DEBUG
    AppReveal.start()
    #endif
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

  let networkMonitor = NetworkMonitor()

  init() {
    // Observe network changes via NotificationCenter
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("NetworkStatusChanged"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.isOnline = self?.networkMonitor.isConnected ?? false
    }
  }
}
