import Foundation
import Observation
import SwiftUI

@MainActor @Observable
final class ResearchAssistant {
    struct Message: Identifiable {
        let id = UUID()
        let role: String
        var text: String
    }
    var messages: [Message] = []
    var pillars: [String] = []
    var scope = ""
    var busy = false
    var error: String?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?

    func send(_ content: String, draft: ResearchDraft, api: DeepWaterAPI) async {
        guard !busy, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        busy = true
        error = nil
        defer {
            busy = false
            socket?.cancel(with: .normalClosure, reason: nil)
            socket = nil
        }
        let previous = messages.suffix(20).map {
            JSONValue.object(["role": .string($0.role), "content": .string($0.text)])
        }
        messages.append(Message(role: "user", text: content))
        do {
            let ticket = try await api.request(
                "/v1/admin/stream-ticket", method: "POST",
                body: .object(["scope": .string("admin:chat")]))
            guard let token = ticket["ticket"].string,
                let url = URL(
                    string: "wss://api.deepwater.live/v1/admin/chat?" + DeepWaterAPI.query(["ticket": token]))
            else {
                throw ServiceError.invalidResponse
            }
            let socket = api.session.webSocketTask(with: url)
            self.socket = socket
            socket.resume()
            let frame: JSONValue = .object([
                "type": .string("message"), "content": .string(content), "mode": .string("create"),
                "pillars": .strings(draft.pillars), "history": .array(previous),
                "context": .object([
                    "config": draft.body, "locked": .strings(Array(draft.body.object.keys))
                ])
            ])
            let encoded = try JSONEncoder().encode(frame)
            guard let frameText = String(data: encoded, encoding: .utf8) else { throw ServiceError.invalidResponse }
            try await socket.send(.string(frameText))
            while !Task.isCancelled {
                let incoming = try await socket.receive()
                let data: Data
                switch incoming {
                case .data(let value): data = value
                case .string(let value): data = Data(value.utf8)
                @unknown default: throw ServiceError.invalidResponse
                }
                let value = try JSONDecoder().decode(JSONValue.self, from: data)
                if consume(value) { return }
            }
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    func cancel() { socket?.cancel(with: .goingAway, reason: nil) }

    func consume(_ value: JSONValue) -> Bool {
        switch value["type"].text {
        case "token":
            if messages.last?.role != "assistant" {
                messages.append(Message(role: "assistant", text: ""))
            }
            messages[messages.count - 1].text += value["content"].text
        case "pillars": pillars = value["data"]["pillars"].array.compactMap(\.string)
        case "scope": scope = value["data"]["approach"].text
        case "turn_break": messages.append(Message(role: "assistant", text: ""))
        case "error":
            error = value["error"].string ?? "The research assistant is unavailable. Try again."
            return true
        case "done": return true
        default: break
        }
        return false
    }
}

struct ResearchAssistantView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    @Bindable var assistant: ResearchAssistant
    @Binding var draft: ResearchDraft
    @State private var input = ""

    var body: some View {
        List {
            Section {
                Text(
                    "Describe what you want to learn. You can review the suggested questions before starting research."
                )
                .foregroundStyle(.secondary)
            }
            ForEach(assistant.messages) { message in
                Section(message.role == "user" ? "You" : "DeepWater") { MarkdownReport(text: message.text) }
            }
            if !assistant.scope.isEmpty { Section("Suggested approach") { Text(assistant.scope) } }
            if !assistant.pillars.isEmpty {
                Section("Suggested questions") {
                    ForEach(assistant.pillars, id: \.self) { Text($0) }
                    Button("Use these questions") {
                        draft.pillars = assistant.pillars
                        dismiss()
                    }
                }
            }
            if assistant.busy { ProgressView("Thinking…") }
            if let error = assistant.error { ErrorNotice(message: error) }
        }
        .navigationTitle("Refine your research").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            HStack(alignment: .bottom) {
                TextField("Message DeepWater", text: $input, axis: .vertical).lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                Button("Send", systemImage: "arrow.up.circle.fill") {
                    let message = input
                    input = ""
                    Task { await assistant.send(message, draft: draft, api: api) }
                }.labelStyle(.iconOnly).font(.title2).disabled(assistant.busy || input.isEmpty)
            }.padding().background(.bar)
        }
        .onAppear { if input.isEmpty && assistant.messages.isEmpty { input = draft.query } }
        .onDisappear { assistant.cancel() }
    }
}
