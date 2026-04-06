import Foundation
import SwiftUI

// ─── Server → Client events (from WebSocket and SSE) ─────────────────────────

enum ServerEvent: Sendable {
  case state(RemoteState)
  case message(RemoteMessage)
  case streamingStart(runId: String, threadId: String)
  case streamingDelta(content: String)
  case streamingDone(content: String, runId: String)
  case subAgentStarted(subAgent: SubAgentSummary)
  case subAgentDone(subAgentId: String, result: String)
  case toolCalled(name: String, input: [String: String])
  case toolDone(name: String)
  case agentWake(agentId: String, reason: String)
  case taskCreated(task: TaskItem)
  case taskStateChanged(taskId: String, fromStatus: String, toStatus: String, reason: String)
  case taskSpawned(taskId: String, parentTaskId: String, role: String, label: String)
  case taskAnnounced(
    taskId: String, parentTaskId: String?,
    status: String, result: String, duration: Int, toolCallCount: Int
  )
  case error(message: String)
  case ping(timestamp: Int64)
}

// ─── REST types (unchanged) ────────────────────────────────────────────────────

struct OrchestratorChatRequest: Encodable {
  let message: String
  let targetAgentId: String
  let threadId: String?
}

struct OrchestratorChatResponse: Decodable {
  let reply: String
}
struct RemoteState: Decodable {
  let agents: [RemoteAgent]
  let messages: [RemoteMessage]
  let subAgents: [SubAgentSummary]
  let isListening: Bool
  let isSpeaking: Bool
  let tasks: [RemoteTask]?
}

struct RemoteAgent: Decodable {
  let id: String
  let name: String
  let type: String
  let responsibility: String
  let trigger: String
  let intervalMinutes: Int?

  func toAppAgent() -> Agent {
    Agent(
      id: id, name: name, type: type,
      responsibility: responsibility, trigger: trigger,
      intervalMinutes: intervalMinutes
    )
  }
}

struct RemoteMessage: Decodable, Sendable {
  let id: String
  let role: String
  let threadId: String
  let content: String
  let timestamp: Double

  func toAppMessage() -> ChatMessage {
    ChatMessage(
      id: id,
      role: ChatMessage.ChatRole(rawValue: role) ?? .system,
      threadId: threadId,
      content: content,
      timestamp: Date(timeIntervalSince1970: timestamp / 1000)
    )
  }
}

struct SubAgentSummary: Codable, Sendable {
  let id: String
  let name: String
  let task: String
  let status: String
}

enum NessieClientError: LocalizedError, Sendable {
  case invalidResponse
  case serverError(statusCode: Int, message: String)
  case webSocketError(String)

  var errorDescription: String? {
    switch self {
    case .invalidResponse: return "Invalid response from helper backend."
    case let .serverError(statusCode, message): return "Error \(statusCode): \(message)"
    case let .webSocketError(msg): return "WebSocket error: \(msg)"
    }
  }
}

// ─── Task event parsing (shared by WS + SSE) ─────────────────────────────────

private func parseTaskItem(from json: [String: Any]) -> TaskItem {
  TaskItem(
    id: json["id"] as? String ?? "",
    parentId: json["parentId"] as? String,
    role: json["role"] as? String ?? "",
    label: json["label"] as? String ?? "",
    status: json["status"] as? String ?? "inbox",
    createdAt: Date(
      timeIntervalSince1970: (json["createdAt"] as? Double ?? 0) / 1000
    ),
    updatedAt: Date(
      timeIntervalSince1970: (json["updatedAt"] as? Double ?? 0) / 1000
    )
  )
}
private func parseTaskEvent(
  type: String, json: [String: Any]
) -> ServerEvent? {
  switch type {
  case "task.created":
    let payload = json["task"] as? [String: Any] ?? json
    return .taskCreated(task: parseTaskItem(from: payload))
  case "task.state_changed":
    return .taskStateChanged(
      taskId: json["taskId"] as? String ?? "",
      fromStatus: json["fromStatus"] as? String ?? "",
      toStatus: json["toStatus"] as? String ?? "",
      reason: json["reason"] as? String ?? ""
    )
  case "task.spawned":
    return .taskSpawned(
      taskId: json["taskId"] as? String ?? "",
      parentTaskId: json["parentTaskId"] as? String ?? "",
      role: json["role"] as? String ?? "",
      label: json["label"] as? String ?? ""
    )
  case "task.announced":
    return .taskAnnounced(
      taskId: json["taskId"] as? String ?? "",
      parentTaskId: json["parentTaskId"] as? String,
      status: json["status"] as? String ?? "",
      result: json["result"] as? String ?? "",
      duration: json["duration"] as? Int ?? 0,
      toolCallCount: json["toolCallCount"] as? Int ?? 0
    )
  default:
    return nil
  }
}

// ─── Main client ───────────────────────────────────────────────────────────────

final class NessieClient: @unchecked Sendable {

  // ─── Configuration ────────────────────────────────────────────────────────

  private let baseURL: URL
  private let wsURL: URL
  private let session: URLSession

  // ─── WebSocket state ────────────────────────────────────────────────────────

  private var webSocketTask: URLSessionWebSocketTask?
  private var wsContinuation: AsyncStream<ServerEvent>.Continuation?
  private var wsReceiveTask: Task<Void, Never>?

  init(baseURL: URL? = nil) {
    let rawURL = ProcessInfo.processInfo.environment["NESSIE_ORCHESTRATOR_URL"]
      ?? "http://127.0.0.1:4317"

    if let provided = baseURL {
      self.baseURL = provided
    } else {
      // swiftlint:disable:next force_unwrapping
      self.baseURL = URL(string: rawURL) ?? URL(string: "http://127.0.0.1:4317")!
    }

    // WebSocket URL derived from the HTTP base URL
    let wsScheme = baseURL?.scheme == "https" ? "wss" : "ws"
    let wsHost = baseURL?.host ?? URL(string: rawURL)?.host ?? "127.0.0.1"
    let wsPort = baseURL?.port ?? URL(string: rawURL)?.port ?? 4317
    // swiftlint:disable:next force_unwrapping
    self.wsURL = URL(string: "\(wsScheme)://\(wsHost):\(wsPort)")!

    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 30
    self.session = URLSession(configuration: cfg)
  }

  // ─── REST: non-streaming chat ───────────────────────────────────────────────

  func send(message: String, targetAgentId: String) async throws -> String {
    var request = URLRequest(url: baseURL.appendingPathComponent("chat/sync"))
    request.httpMethod = "POST"
    request.timeoutInterval = 60
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let body = OrchestratorChatRequest(
      message: message,
      targetAgentId: targetAgentId,
      threadId: nil
    )
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await session.data(for: request)
    try validate(response: response, data: data)

    let decoded = try JSONDecoder().decode(OrchestratorChatResponse.self, from: data)
    return decoded.reply
  }

  func fetchState() async throws -> RemoteState {
    let (data, response) = try await session.data(from: baseURL.appendingPathComponent("state"))
    try validate(response: response, data: data)
    return try JSONDecoder().decode(RemoteState.self, from: data)
  }

  // ─── SSE: streaming chat ────────────────────────────────────────────────────
  // POST /chat returns text/event-stream.
  // Each event is yielded as a ServerEvent.
  // The caller receives streaming deltas and the final assembled message.

  func streamChat(
    message: String,
    targetAgentId: String
  ) -> AsyncStream<ServerEvent> {
    AsyncStream { continuation in
      Task {
        var request = URLRequest(url: baseURL.appendingPathComponent("chat"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

        let body = OrchestratorChatRequest(
          message: message,
          targetAgentId: targetAgentId,
          threadId: nil
        )
        request.httpBody = try? JSONEncoder().encode(body)

        let task = session.dataTask(with: request) { data, _, error in
          if let error = error {
            continuation.yield(.error(message: error.localizedDescription))
            continuation.finish()
            return
          }

          guard let data = data, let text = String(data: data, encoding: .utf8) else {
            continuation.yield(.error(message: "Empty response"))
            continuation.finish()
            return
          }

          // Parse SSE lines: "event: <name>\ndata: <json>\n\n"
          var currentEvent = ""
          var currentData = ""

          for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
              // End of event — dispatch
              if !currentEvent.isEmpty || !currentData.isEmpty {
                if let event = self.parseSSELine(event: currentEvent, data: currentData) {
                  continuation.yield(event)
                }
              }
              currentEvent = ""
              currentData = ""
            } else if trimmed.hasPrefix("event:") {
              currentEvent = String(trimmed.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("data:") {
              currentData = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            }
          }

          continuation.finish()
        }

        _ = task
        task.resume()
      }
    }
  }

  // ─── WebSocket: persistent event stream ──────────────────────────────────────
  // Call connectWebSocket() once, then consume the returned AsyncStream.
  // Events include full state on connect and incremental updates thereafter.
  // The caller should hold the stream alive; it terminates on disconnect.

  func connectWebSocket() -> AsyncStream<ServerEvent> {
    AsyncStream { continuation in
      // Receive loop — runs until WS closes or stream is cancelled
      let receiveTask = Task { [weak self] in
        guard let self = self else { return }
        await self.wsReceiveLoop(continuation: continuation)
        continuation.finish()
      }

      // Ping keepalive — runs until cancelled
      Task { [weak self] in
        guard let self = self else { return }
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(25))
          self.webSocketTask?.sendPing { error in
            if error == nil {
              continuation.yield(.ping(timestamp: Int64(Date().timeIntervalSince1970 * 1000)))
            }
          }
        }
      }

      // Store receiveTask so disconnect() can cancel it
      self.wsReceiveTask = receiveTask
    }
  }

  private func wsReceiveLoop(
    continuation: AsyncStream<ServerEvent>.Continuation
  ) async {
    guard let task = URLSession.shared.webSocketTask(with: wsURL) as URLSessionWebSocketTask? else {
      continuation.yield(.error(message: "Failed to create WebSocket task"))
      return
    }

    self.webSocketTask = task
    task.resume()

    while !Task.isCancelled {
      do {
        let message = try await task.receive()
        switch message {
        case .string(let text):
          if let event = parseWSMessage(text) {
            continuation.yield(event)
          }
        case .data:
          break
        @unknown default:
          break
        }
      } catch {
        // Socket closed or errored — yield error and terminate
        continuation.yield(.error(message: error.localizedDescription))
        break
      }
    }

    self.webSocketTask?.cancel(with: .goingAway, reason: nil)
    self.webSocketTask = nil
  }

  func disconnectWebSocket() {
    webSocketTask?.cancel(with: .goingAway, reason: nil)
    webSocketTask = nil
    wsReceiveTask?.cancel()
    wsReceiveTask = nil
    // Also nil out the session so new connections can be made
    wsReceiveTask = nil
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private func validate(response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else {
      throw NessieClientError.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = String(data: data, encoding: .utf8) ?? "Unknown error"
      throw NessieClientError.serverError(statusCode: http.statusCode, message: message)
    }
  }

  private func parseWSMessage(_ text: String) -> ServerEvent? {
    guard let data = text.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = json["type"] as? String else { return nil }

    switch type {
    case "state":
      guard let stateData = json["data"] as? [String: Any],
            let stateJson = try? JSONSerialization.data(withJSONObject: stateData),
            let state = try? JSONDecoder().decode(RemoteState.self, from: stateJson)
      else { return nil }
      return .state(state)
    case "message":
      guard let msgObj = json["message"],
            let msgData = try? JSONSerialization.data(withJSONObject: msgObj),
            let msg = try? JSONDecoder().decode(RemoteMessage.self, from: msgData)
      else { return nil }
      return .message(msg)
    case "pong":
      return .ping(timestamp: json["ts"] as? Int64 ?? 0)
    default:
      return parseSharedEvent(type: type, json: json)
    }
  }

  private func parseSSELine(event: String, data: String) -> ServerEvent? {
    guard let jsonData = data.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
    else { return nil }

    let mapped: String
    switch event {
    case "start": mapped = "streaming.start"
    case "delta": mapped = "streaming.delta"
    case "done": mapped = "streaming.done"
    case "message":
      guard let msgData = try? JSONSerialization.data(withJSONObject: json),
            let msg = try? JSONDecoder().decode(RemoteMessage.self, from: msgData)
      else { return nil }
      return .message(msg)
    default: mapped = event
    }
    return parseSharedEvent(type: mapped, json: json)
  }

  private func parseSharedEvent(type: String, json: [String: Any]) -> ServerEvent? {
    switch type {
    case "streaming.start":
      return .streamingStart(
        runId: json["runId"] as? String ?? "", threadId: json["threadId"] as? String ?? ""
      )
    case "streaming.delta":
      return .streamingDelta(content: json["content"] as? String ?? "")
    case "streaming.done":
      return .streamingDone(content: json["content"] as? String ?? "", runId: json["runId"] as? String ?? "")
    case "subagent.started":
      let src = json["subAgent"] as? [String: Any] ?? json
      guard let saData = try? JSONSerialization.data(withJSONObject: src),
            let sub = try? JSONDecoder().decode(SubAgentSummary.self, from: saData)
      else { return nil }
      return .subAgentStarted(subAgent: sub)
    case "subagent.done":
      return .subAgentDone(
        subAgentId: json["subAgentId"] as? String ?? "", result: json["result"] as? String ?? ""
      )
    case "tool.called":
      return .toolCalled(
        name: json["name"] as? String ?? "",
        input: (json["input"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
      )
    case "tool.done":
      return .toolDone(name: json["name"] as? String ?? "")
    case "agent.wake":
      return .agentWake(agentId: json["agentId"] as? String ?? "", reason: json["reason"] as? String ?? "")
    case "task.created", "task.state_changed", "task.spawned", "task.announced":
      return parseTaskEvent(type: type, json: json)
    case "error":
      return .error(message: json["message"] as? String ?? "Unknown error")
    default:
      return nil
    }
  }
}
