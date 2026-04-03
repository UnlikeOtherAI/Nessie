import SwiftUI

struct StatusBar: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    HStack {
      Circle()
        .fill(appState.isOnline ? Color.green : Color.red)
        .frame(width: 8, height: 8)

      Text(appState.isOnline ? "Online" : "Offline")
        .font(.system(size: 11))
        .foregroundColor(.secondary)

      Spacer()

      if appState.hotwordReady {
        Text("\"Hey Agent\" ready")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Color(nsColor: .windowBackgroundColor))
  }
}
