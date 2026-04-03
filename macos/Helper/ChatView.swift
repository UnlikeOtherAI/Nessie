import SwiftUI

struct ChatView: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    VStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(appState.messages) { message in
              MessageBubble(message: message)
                .id(message.id)
            }
          }
          .padding()
        }
        .onChange(of: appState.messages.count) { _ in
          if let lastId = appState.messages.last?.id {
            withAnimation {
              proxy.scrollTo(lastId, anchor: .bottom)
            }
          }
        }
      }
    }
  }
}

struct MessageBubble: View {
  let message: ChatMessage

  var body: some View {
    HStack {
      if message.role == .user { Spacer() }

      VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
        Text(message.content)
          .font(.system(size: 14))
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(message.role == .user ? Color.accentColor : Color(nsColor: .controlBackgroundColor))
          .foregroundColor(message.role == .user ? .white : .primary)
          .cornerRadius(12)

        Text(message.timestamp, style: .time)
          .font(.caption2)
          .foregroundColor(.secondary)
      }

      if message.role != .user { Spacer() }
    }
  }
}
