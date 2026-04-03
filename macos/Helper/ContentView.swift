import SwiftUI

struct ContentView: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    HStack(spacing: 0) {
      AgentSidebar()
        .frame(width: 220)

      Divider()

      VStack(spacing: 0) {
        ChatView()

        Divider()

        InputBar()
      }
    }
    .frame(minWidth: 800, minHeight: 600)
    .onReceive(appState.networkMonitor.$isConnected) { connected in
      appState.isOnline = connected
    }
  }
}
