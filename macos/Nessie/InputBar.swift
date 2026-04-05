import SwiftUI
import AppKit

struct InputBar: View {
  @EnvironmentObject var appState: AppState
  @State private var text = ""
  @Binding var voiceModePresented: Bool

  var body: some View {
    HStack(spacing: 8) {
      AppKitActionButton(
        title: voiceModePresented ? "Stop" : "Voice",
        systemImage: voiceModePresented ? "mic.fill" : "mic",
        accessibilityIdentifier: "mic_button",
        accessibilityLabel: voiceModePresented ? "Close voice mode" : "Open voice mode",
        isEnabled: true
      ) {
        voiceModePresented.toggle()
      }
      .frame(width: 72, height: 28)

      AppKitMessageField(
        text: $text,
        placeholder: "Type a message...",
        accessibilityIdentifier: "type_a_message",
        accessibilityLabel: "Message input"
      ) {
        send()
      }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(8)

      AppKitActionButton(
        title: "Send",
        systemImage: "arrow.up.circle.fill",
        accessibilityIdentifier: "send_message_button",
        accessibilityLabel: "Send message",
        isEnabled: !appState.isStreaming
      ) {
        send()
      }
      .frame(width: 72, height: 28)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .accessibilityIdentifier("input_bar")
  }

  private func send() {
    let liveText = currentComposerText()
    guard !liveText.isEmpty else { return }
    let content = liveText
    text = ""
    clearComposerField()
    Task {
      await appState.sendMessage(content)
    }
  }

  private func currentComposerText() -> String {
    let trimmedState = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedState.isEmpty {
      return trimmedState
    }

    guard let field = findEditableTextField(in: NSApp.keyWindow?.contentView) else {
      return ""
    }
    let liveEditorText = field.currentEditor()?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !liveEditorText.isEmpty {
      return liveEditorText
    }
    return field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func clearComposerField() {
    guard let field = findEditableTextField(in: NSApp.keyWindow?.contentView) else {
      return
    }
    field.stringValue = ""
    field.currentEditor()?.string = ""
  }

  private func findEditableTextField(in view: NSView?) -> NSTextField? {
    guard let view else { return nil }

    if let textField = view as? NSTextField, textField.isEditable {
      return textField
    }

    for subview in view.subviews {
      if let textField = findEditableTextField(in: subview) {
        return textField
      }
    }

    return nil
  }
}

struct AppKitActionButton: NSViewRepresentable {
  let title: String
  let systemImage: String
  let accessibilityIdentifier: String
  let accessibilityLabel: String
  let isEnabled: Bool
  let action: () -> Void

  func makeNSView(context: Context) -> AppRevealButton {
    let button = AppRevealButton(title: title, target: nil, action: nil)
    button.target = button
    button.action = #selector(AppRevealButton.handlePress)
    button.onPress = action
    button.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: accessibilityLabel)
    button.imagePosition = .imageLeading
    button.bezelStyle = .rounded
    button.isBordered = false
    button.isEnabled = isEnabled
    button.setButtonType(.momentaryPushIn)
    button.font = .systemFont(ofSize: 13, weight: .medium)
    button.setAccessibilityLabel(accessibilityLabel)
    button.setAccessibilityIdentifier(accessibilityIdentifier)
    return button
  }

  func updateNSView(_ button: AppRevealButton, context: Context) {
    button.title = title
    button.onPress = action
    button.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: accessibilityLabel)
    button.isEnabled = isEnabled
    button.contentTintColor = isEnabled ? .controlAccentColor : .secondaryLabelColor
    button.setAccessibilityLabel(accessibilityLabel)
    button.setAccessibilityIdentifier(accessibilityIdentifier)
  }
}

final class AppRevealButton: NSButton {
  var onPress: () -> Void = {}

  @objc func handlePress() {
    onPress()
  }

  override func accessibilityPerformPress() -> Bool {
    guard isEnabled else { return false }
    onPress()
    return true
  }
}

struct AppKitMessageField: NSViewRepresentable {
  @Binding var text: String
  let placeholder: String
  let accessibilityIdentifier: String
  let accessibilityLabel: String
  let onSubmit: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(text: $text, onSubmit: onSubmit)
  }

  func makeNSView(context: Context) -> NSTextField {
    let textField = NSTextField(string: text)
    textField.delegate = context.coordinator
    textField.isBordered = false
    textField.drawsBackground = false
    textField.focusRingType = .none
    textField.placeholderString = placeholder
    textField.target = context.coordinator
    textField.action = #selector(Coordinator.handleSubmit)
    textField.setAccessibilityLabel(accessibilityLabel)
    textField.setAccessibilityIdentifier(accessibilityIdentifier)
    return textField
  }

  func updateNSView(_ textField: NSTextField, context: Context) {
    if textField.stringValue != text {
      textField.stringValue = text
    }
    textField.placeholderString = placeholder
    textField.setAccessibilityLabel(accessibilityLabel)
    textField.setAccessibilityIdentifier(accessibilityIdentifier)
    context.coordinator.onSubmit = onSubmit
  }

  final class Coordinator: NSObject, NSTextFieldDelegate {
    @Binding var text: String
    var onSubmit: () -> Void

    init(text: Binding<String>, onSubmit: @escaping () -> Void) {
      _text = text
      self.onSubmit = onSubmit
    }

    func controlTextDidChange(_ notification: Notification) {
      guard let textField = notification.object as? NSTextField else { return }
      text = textField.stringValue
    }

    @objc func handleSubmit() {
      onSubmit()
    }
  }
}
