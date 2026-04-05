import SwiftUI

struct ChatView: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(appState.visibleMessages) { message in
            MessageBubble(message: message)
              .id(message.id)
          }

          // ── Streaming in-progress bubble ───────────────────────────────────
          if appState.isThinking, !appState.streamingContent.isEmpty {
            StreamingBubble(content: appState.streamingContent)
              .id("streaming")
          }

          // ── Typing indicator (no content yet) ─────────────────────────────
          if appState.isThinking, appState.streamingContent.isEmpty {
            TypingIndicator()
              .id("typing")
          }
        }
        .padding()
        .accessibilityIdentifier("chat_message_list")
      }
      .onChange(of: appState.visibleMessages.count) { _ in scrollToBottom(proxy: proxy) }
      .onChange(of: appState.streamingContent) { _ in scrollToBottom(proxy: proxy) }
    }
  }

  private func scrollToBottom(proxy: ScrollViewProxy) {
    if let lastId = appState.visibleMessages.last?.id {
      withAnimation(.easeOut(duration: 0.2)) {
        proxy.scrollTo(lastId, anchor: .bottom)
      }
    } else {
      withAnimation(.easeOut(duration: 0.2)) {
        proxy.scrollTo("streaming", anchor: .bottom)
      }
    }
  }
}

// ─── Message bubble ─────────────────────────────────────────────────────────────

struct MessageBubble: View {
  let message: ChatMessage

  var body: some View {
    HStack {
      if message.role == .user { Spacer() }

      VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
        if message.role == .system {
          Text("System")
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.secondary)
        }

        Group {
          if message.role == .user {
            Text(message.content)
              .font(.system(size: 14))
              .foregroundColor(.white)
          } else if let attrStr = try? AttributedString(
            markdown: message.content,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
          ) {
            Text(attrStr)
              .font(.system(size: 14))
              .foregroundColor(.primary)
          } else {
            Text(message.content)
              .font(.system(size: 14))
              .foregroundColor(.primary)
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(bubbleBackground)
        .clipShape(RoundedBubble(role: message.role))

        Text(message.timestamp, style: .time)
          .font(.caption2)
          .foregroundColor(.secondary.opacity(0.7))
      }

      if message.role != .user { Spacer() }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(roleName) message: \(message.content)")
    .accessibilityIdentifier("message_\(message.id)")
  }

  private var bubbleBackground: Color {
    switch message.role {
    case .user: return Color.accentColor
    case .assistant: return Color(nsColor: .controlBackgroundColor)
    case .system: return Color.orange.opacity(0.1)
    }
  }

  private var roleName: String {
    switch message.role {
    case .user: return "User"
    case .assistant: return "Assistant"
    case .system: return "System"
    }
  }
}

// ─── Bubble shape ─────────────────────────────────────────────────────────────────

struct RoundedBubble: Shape {
  let role: ChatMessage.ChatRole

  func path(in rect: CGRect) -> Path {
    let radius: CGFloat = 16
    let tail: CGFloat = 6

    var path = Path()
    if role == .user {
      // Right-pointing bubble
      path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
    } else {
      // Left-pointing bubble
      path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
    }
    return path
  }
}

// ─── Streaming bubble ───────────────────────────────────────────────────────────

struct StreamingBubble: View {
  let content: String

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 4) {
          Text("Nessie")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)

          StreamingBadge()
        }

        Text(content + cursor)
          .font(.system(size: 14))
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(Color(nsColor: .controlBackgroundColor))
          .cornerRadius(12)
      }

      Spacer()
    }
    .accessibilityIdentifier("streaming_message")
  }

  private var cursor: String { "▊" }  // blinking cursor character
}

// ─── Streaming indicator badge ─────────────────────────────────────────────────

struct StreamingBadge: View {
  @State private var visible = true

  var body: some View {
    HStack(spacing: 2) {
      ForEach(0..<3, id: \.self) { idx in
        Circle()
          .fill(Color.orange)
          .frame(width: 4, height: 4)
          .opacity(visible ? 0.3 : 1.0)
          .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(idx) * 0.2), value: visible)
      }
    }
    .onAppear { visible = true }
    .accessibilityLabel("Generating response")
  }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

struct TypingIndicator: View {
  @State private var phase = 0

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 4) {
          Text("Nessie")
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)

          StreamingBadge()
        }

        HStack(spacing: 3) {
          ForEach(0..<3, id: \.self) { idx in
            Capsule()
              .fill(Color.secondary.opacity(0.4))
              .frame(width: 7, height: 7)
              .offset(y: phase == idx ? -3 : 0)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(12)
      }

      Spacer()
    }
    .onAppear {
      withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
        phase = (phase + 1) % 3
      }
    }
    .accessibilityIdentifier("typing_indicator")
  }
}
