import SwiftUI

struct ContentView: View {
  @EnvironmentObject var appState: AppState
  @State private var statusPanelOpen = false
  @State private var voiceModePresented = false

  var body: some View {
    ZStack {
      HStack(spacing: 0) {
        SessionsSidebar(statusPanelOpen: $statusPanelOpen)
          .frame(width: 220)

        Divider()

        VStack(spacing: 0) {
          ChatView()

          Divider()

          InputBar(voiceModePresented: $voiceModePresented)
        }

        if statusPanelOpen {
          Divider()
          StatusPanel(isOpen: $statusPanelOpen)
        }
      }

      if voiceModePresented {
        VoiceModeView(isPresented: $voiceModePresented)
      }
    }
    .frame(minWidth: 800, minHeight: 600)
  }
}
