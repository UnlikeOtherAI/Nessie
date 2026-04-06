import SwiftUI

struct ChatView: View {
  @EnvironmentObject var appState: AppState
  @State private var showDeleteConfirm = false

  var body: some View {
    VStack(spacing: 0) {
      // ── Toolbar ────────────────────────────────────────────────────────────
      chatToolbar

      Divider()

      // ── Messages ──────────────────────────────────────────────────────────
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(appState.visibleMessages) { message in
              MessageBubble(message: message)
                .id(message.id)
            }

            if appState.isThinking, !appState.streamingContent.isEmpty {
              StreamingBubble(content: appState.streamingContent)
                .id("streaming")
            }

            if appState.isThinking, appState.streamingContent.isEmpty {
              TypingIndicator()
                .id("typing")
            }
          }
          .padding()
          .textSelection(.enabled)
          .accessibilityIdentifier("chat_message_list")
        }
        .onChange(of: appState.visibleMessages.count) { _ in scrollToBottom(proxy: proxy) }
        .onChange(of: appState.streamingContent) { _ in scrollToBottom(proxy: proxy) }
      }
    }
    .alert("Delete History", isPresented: $showDeleteConfirm) {
      Button("Delete", role: .destructive) { appState.deleteHistory() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This will permanently delete all conversations and context. This cannot be undone.")
    }
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────────

  private var chatToolbar: some View {
    HStack {
      Spacer()

      Button {
        copyAllMessages()
      } label: {
        Image(systemName: "doc.on.doc")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
      .help("Copy all messages")
      .accessibilityIdentifier("copy_messages_button")

      Button {
        showDeleteConfirm = true
      } label: {
        Image(systemName: "trash")
          .font(.system(size: 12))
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
      .help("Delete History")
      .accessibilityIdentifier("delete_history_button")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 6)
  }

  private func copyAllMessages() {
    let text = formatMessagesForCopy(appState.visibleMessages)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
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

// ─── Cmd+C handler ──────────────────────────────────────────────────────────

private func formatMessagesForCopy(_ messages: [ChatMessage]) -> String {
  let formatter = DateFormatter()
  formatter.dateFormat = "yyyy-MM-dd HH:mm"

  return messages.map { msg in
    let date = formatter.string(from: msg.timestamp)
    let sender: String
    switch msg.role {
    case .user: sender = "Me"
    case .assistant: sender = "Nessie"
    case .system: sender = "System"
    }
    return "[\(date)] \(sender): \(msg.content)"
  }.joined(separator: "\n")
}

// Empty — native .textSelection(.enabled) handles Cmd+C for selected text.

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
            options: AttributedString.MarkdownParsingOptions(
              interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
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

    var path = Path()
    if role == .user {
      path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
    } else {
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

  private var cursor: String { "\u{2588}" }
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
          .animation(
            .easeInOut(duration: 0.6).repeatForever().delay(Double(idx) * 0.2),
            value: visible
          )
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
