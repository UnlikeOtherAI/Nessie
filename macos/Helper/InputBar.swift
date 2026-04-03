import SwiftUI

struct InputBar: View {
  @EnvironmentObject var appState: AppState
  @State private var text = ""

  var body: some View {
    HStack(spacing: 8) {
      Button {
        appState.isListening.toggle()
      } label: {
        Image(systemName: appState.isListening ? "mic.fill" : "mic")
          .font(.system(size: 16))
          .foregroundColor(appState.isListening ? .red : .secondary)
      }
      .buttonStyle(.plain)

      TextField("Type a message...", text: $text)
        .textFieldStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(8)
        .onSubmit {
          send()
        }

      Button {
        send()
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 22))
          .foregroundColor(text.isEmpty ? .secondary : .accentColor)
      }
      .buttonStyle(.plain)
      .disabled(text.isEmpty)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }

  private func send() {
    guard !text.isEmpty else { return }
    let content = text
    text = ""
    appState.messages.append(ChatMessage(role: .user, content: content, timestamp: Date()))
    // TODO: send to orchestrator
  }
}
