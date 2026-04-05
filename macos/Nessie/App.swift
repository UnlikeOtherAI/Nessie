import SwiftUI

#if DEBUG
import AppReveal
#endif

@main
struct NessieApp: App {
  @StateObject private var appState = AppState()
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(appState)
    }
  }
}

// AppReveal integration — starts the MCP server for testing in DEBUG builds
class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    #if DEBUG
    AppReveal.start()
    #endif
  }
}

// ─── App state ─────────────────────────────────────────────────────────────────

@MainActor
final class AppState: ObservableObject {

  // ─── Connection ─────────────────────────────────────────────────────────────

  @Published private(set) var isOnline = true
  @Published private(set) var isBackendReachable = false

  // ─── Voice ─────────────────────────────────────────────────────────────────

  @Published var isListening = false
  @Published var isSpeaking = false
  @Published var isThinking = false
  @Published private(set) var hotwordReady = true

  // ─── Sessions / threads ────────────────────────────────────────────────────

  @Published private(set) var sessions: [Session] = []
  @Published var selectedSession: Session?

  // ─── Agents ─────────────────────────────────────────────────────────────────

  @Published private(set) var agents: [Agent] = [
    Agent(
      id: "main", name: "Nessie", type: "orchestrator",
      responsibility: "Primary orchestrator.", trigger: "main",
      intervalMinutes: nil
    )
  ]
  @Published private(set) var selectedAgent: Agent?

  // ─── Messages ───────────────────────────────────────────────────────────────

  /** All messages, partitioned by session in displayedSessions */
  @Published private(set) var allMessages: [ChatMessage] = []

  /** Messages for the currently selected session */
  var visibleMessages: [ChatMessage] {
    let id = selectedSession?.threadId ?? selectedAgent?.id ?? "main"
    return allMessages.filter { $0.threadId == id }
  }

  // ─── Streaming ─────────────────────────────────────────────────────────────

  /** Partial content being streamed for the active run (assembled from deltas) */
  @Published private(set) var streamingContent: String = ""

  /** The runId of the currently streaming response */
  @Published private(set) var streamingRunId: String?

  /** True while a streaming response is in progress */
  @Published private(set) var isStreaming = false

  // ─── Sub-agents ─────────────────────────────────────────────────────────────

  @Published private(set) var activeSubAgents: [SubAgentSummary] = []

  // ─── Tool calls ────────────────────────────────────────────────────────────

  /** Last N tool invocations, most recent first */
  @Published private(set) var recentToolCalls: [ToolCallEntry] = []

  // ─── Backend client ────────────────────────────────────────────────────────

  private let client = NessieClient()
  private var eventTask: Task<Void, Never>?
  private var streamingTask: Task<Void, Never>?

  // ─── Init ──────────────────────────────────────────────────────────────────

  init() {
    Task { await connect() }
  }

  // ─── Connect / disconnect ──────────────────────────────────────────────────

  func connect() {
    eventTask?.cancel()

    eventTask = Task {
      // Check backend health
      do {
        let state = try await client.fetchState()
        self.isBackendReachable = true
        self.applyState(state)
      } catch {
        self.isBackendReachable = false
      }

      // Start WebSocket event stream
      for await event in client.connectWebSocket() {
        await self.handleEvent(event)
      }

      // WS disconnected — retry after delay
      if !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        await self.connect()
      }
    }
  }

  func disconnect() {
    eventTask?.cancel()
    streamingTask?.cancel()
    client.disconnectWebSocket()
  }

  // ─── Event handler ──────────────────────────────────────────────────────────

  private func handleEvent(_ event: ServerEvent) async {
    switch event {
    case .state(let state):
      applyState(state)

    case .message(let msg):
      let chatMsg = msg.toAppMessage()
      // Avoid duplicates
      if !allMessages.contains(where: { $0.id == chatMsg.id }) {
        allMessages.append(chatMsg)
      }

    case .streamingStart(let runId, _):
      streamingRunId = runId
      streamingContent = ""
      isThinking = true
      isStreaming = true

    case .streamingDelta(let content):
      streamingContent += content

    case .streamingDone:
      // Message is added via the `message` broadcast event — don't double-add
      streamingContent = ""
      streamingRunId = nil
      isThinking = false
      isStreaming = false

    case .subAgentStarted(let subAgent):
      if !activeSubAgents.contains(where: { $0.id == subAgent.id }) {
        activeSubAgents.append(subAgent)
      }

    case .subAgentDone(let subAgentId, _):
      activeSubAgents.removeAll { $0.id == subAgentId }

    case .toolCalled(let name, let input):
      let entry = ToolCallEntry(id: UUID().uuidString, name: name, input: input, timestamp: Date())
      recentToolCalls.insert(entry, at: 0)
      if recentToolCalls.count > 10 {
        recentToolCalls = Array(recentToolCalls.prefix(10))
      }

    case .toolDone(let name):
      // Mark the most recent matching entry as done
      if let idx = recentToolCalls.firstIndex(where: { $0.name == name && $0.doneAt == nil }) {
        recentToolCalls[idx] = ToolCallEntry(
          id: recentToolCalls[idx].id,
          name: name,
          input: recentToolCalls[idx].input,
          timestamp: recentToolCalls[idx].timestamp,
          doneAt: Date()
        )
      }

    case .agentWake(let agentId, _):
      // Refresh agent state
      if let state = try? await client.fetchState() {
        applyState(state)
      }

    case .error:
      // On any error, reset streaming state
      streamingContent = ""
      streamingRunId = nil
      isThinking = false
      isStreaming = false

    case .ping:
      isOnline = true
    }
  }

  private func applyState(_ state: RemoteState) {
    agents = state.agents.map { $0.toAppAgent() }

    if selectedAgent == nil, let first = agents.first {
      selectedAgent = first
    }
    if let id = selectedAgent?.id, let updated = agents.first(where: { $0.id == id }) {
      selectedAgent = updated
    }

    allMessages = state.messages.map { $0.toAppMessage() }
    activeSubAgents = state.subAgents

    // Sync session list from messages
    syncSessions()

    isOnline = true
    isBackendReachable = true
    isListening = state.isListening
    isSpeaking = state.isSpeaking
  }

  // ─── Session management ─────────────────────────────────────────────────────

  private func syncSessions() {
    // Group messages by threadId and create session summaries
    let grouped = Dictionary(grouping: allMessages) { $0.threadId }

    var updated: [Session] = []
    for (threadId, messages) in grouped {
      let sorted = messages.sorted { $0.timestamp < $1.timestamp }
      let preview = sorted.last?.content ?? ""
      let name = sessionName(for: threadId, messages: sorted)
      updated.append(Session(
        id: threadId,
        name: name,
        threadId: threadId,
        createdAt: sorted.first?.timestamp ?? Date(),
        updatedAt: sorted.last?.timestamp ?? Date(),
        messageCount: messages.count,
        preview: String(preview.prefix(100)),
        agentId: threadId.components(separatedBy: ":").first ?? "main"
      ))
    }

    sessions = updated.sorted { $0.updatedAt > $1.updatedAt }

    // Ensure current selection still exists
    if let selected = selectedSession, !sessions.contains(where: { $0.id == selected.id }) {
      selectedSession = sessions.first
    }
    if selectedSession == nil {
      selectedSession = sessions.first
    }
  }

  private func sessionName(for threadId: String, messages: [ChatMessage]) -> String {
    if threadId == "main" { return "Main Chat" }
    // Use first non-system message content as name
    let first = messages.first(where: { $0.role != .system })?.content ?? ""
    return first.isEmpty ? threadId : String(first.prefix(40))
  }

  // ─── Send message ──────────────────────────────────────────────────────────

  func sendMessage(_ content: String) {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    let threadId = selectedSession?.threadId ?? selectedAgent?.id ?? "main"

    // Cancel any existing streaming
    streamingTask?.cancel()

    // Use SSE streaming — messages arrive via handleEvent from WS broadcast + SSE events
    streamingTask = Task {
      for await event in client.streamChat(message: trimmed, targetAgentId: threadId) {
        await self.handleEvent(event)
      }
    }
  }

  // ─── Session selection ──────────────────────────────────────────────────────

  func selectSession(_ session: Session) {
    selectedSession = session
    streamingContent = ""
    streamingRunId = nil
    isThinking = false
  }

  // ─── Agent selection ───────────────────────────────────────────────────────

  func selectAgent(_ agent: Agent) {
    selectedAgent = agent
    // Find or create a session for this agent
    if let existing = sessions.first(where: { $0.threadId == agent.id }) {
      selectedSession = existing
    } else {
      let newSession = Session(
        id: agent.id,
        name: agent.name,
        threadId: agent.id,
        createdAt: Date(),
        updatedAt: Date(),
        messageCount: 0,
        preview: "",
        agentId: agent.id
      )
      sessions.insert(newSession, at: 0)
      selectedSession = newSession
    }
  }

  deinit {
    eventTask?.cancel()
    streamingTask?.cancel()
  }
}
