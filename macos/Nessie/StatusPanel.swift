import SwiftUI

struct StatusPanel: View {
  @EnvironmentObject var appState: AppState
  @Binding var isOpen: Bool

  var body: some View {
    VStack(spacing: 0) {
      header

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {

          // ── Alerts ───────────────────────────────────────────────────────────
          if !appState.watcherAlerts.isEmpty {
            section("ALERTS") {
              ForEach(appState.watcherAlerts) { alert in
                alertRow(alert)
              }
            }
          }

          // ── Tasks ───────────────────────────────────────────────────────────
          if !appState.tasks.isEmpty {
            section("TASKS") {
              spawnStatusBar
              ForEach(appState.tasks) { task in
                taskRow(task)
              }
            }
          }

          // ── Validators ──────────────────────────────────────────────────────
          if !appState.validatorResults.isEmpty {
            section("VALIDATORS") {
              ForEach(appState.validatorResults) { entry in
                validatorRow(entry)
              }
            }
          }

          // ── Sub-agents ─────────────────────────────────────────────────────
          if !appState.activeSubAgents.isEmpty {
            section("SUB-AGENTS") {
              ForEach(appState.activeSubAgents, id: \.id) { subAgent in
                subAgentRow(subAgent)
              }
            }
          }

          // ── Tool calls ────────────────────────────────────────────────────
          if !appState.recentToolCalls.isEmpty {
            section("TOOL CALLS") {
              ForEach(appState.recentToolCalls) { entry in
                toolCallRow(entry)
              }
            }
          }

          // ── Agent activity ────────────────────────────────────────────────
          section("AGENTS") {
            ForEach(appState.agents, id: \.id) { agent in
              agentStatusRow(agent)
            }
          }

          // ── Voice state ────────────────────────────────────────────────────
          section("VOICE") {
            HStack(spacing: 12) {
              voiceStatePill(
                label: "Listening",
                icon: "mic.fill",
                active: appState.isListening,
                color: .green
              )
              voiceStatePill(
                label: "Speaking",
                icon: "speaker.wave.2.fill",
                active: appState.isSpeaking,
                color: .blue
              )
              voiceStatePill(
                label: "Thinking",
                icon: "brain",
                active: appState.isThinking,
                color: .orange
              )
            }
          }

          // ── Connection ────────────────────────────────────────────────────
          section("CONNECTION") {
            HStack {
              Circle()
                .fill(appState.isBackendReachable ? Color.green : Color.red)
                .frame(width: 8, height: 8)
              Text(appState.isBackendReachable ? "Nessie backend reachable" : "Nessie backend offline")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
              Spacer()
              if appState.isBackendReachable {
                Text("ws://127.0.0.1:4317")
                  .font(.system(size: 10))
                  .foregroundColor(.secondary.opacity(0.7))
              }
            }
          }
        }
        .padding()
      }
    }
    .frame(width: isOpen ? 280 : 0)
    .background(Color(nsColor: .windowBackgroundColor).opacity(0.98))
    .animation(.easeInOut(duration: 0.2), value: isOpen)
    .accessibilityIdentifier("status_panel")
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  private var header: some View {
    HStack {
      Text("Activity")
        .font(.system(size: 13, weight: .semibold))
      Spacer()
      Button {
        isOpen = false
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(Color(nsColor: .controlBackgroundColor))
    .accessibilityIdentifier("status_panel_header")
  }

  // ─── Section ────────────────────────────────────────────────────────────────

  @ViewBuilder
  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 10, weight: .bold))
        .foregroundColor(.secondary.opacity(0.8))
      content()
    }
  }

  // ─── Sub-agent row ────────────────────────────────────────────────────────

  private func subAgentRow(_ subAgent: SubAgentSummary) -> some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.small)
      VStack(alignment: .leading, spacing: 1) {
        Text(subAgent.name)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
        Text(subAgent.task)
          .font(.system(size: 10))
          .foregroundColor(.secondary)
          .lineLimit(1)
      }
      Spacer()
      Text(subAgent.status.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(.orange)
    }
    .padding(.vertical, 4)
    .accessibilityIdentifier("subagent_\(subAgent.id)")
  }

  // ─── Tool call row ────────────────────────────────────────────────────────

  private func toolCallRow(_ entry: ToolCallEntry) -> some View {
    HStack(spacing: 8) {
      Image(systemName: toolIcon(for: entry.name))
        .font(.system(size: 10))
        .foregroundColor(.secondary)
        .frame(width: 16)

      VStack(alignment: .leading, spacing: 1) {
        Text(entry.name)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)

        if let firstValue = entry.input.values.first {
          Text(String(describing: firstValue).prefix(30))
            .font(.system(size: 10))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
      }

      Spacer()

      if entry.isDone {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 10))
          .foregroundColor(.green)
      } else {
        ProgressView()
          .controlSize(.mini)
      }
    }
    .padding(.vertical, 3)
    .accessibilityIdentifier("toolcall_\(entry.id)")
  }

  // ─── Agent status row ─────────────────────────────────────────────────────

  private func agentStatusRow(_ agent: Agent) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(agentColor(for: agent))
        .frame(width: 7, height: 7)

      Text(agent.name)
        .font(.system(size: 12, weight: .medium))

      Spacer()

      Text(agent.trigger.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(.secondary)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Color.secondary.opacity(0.1))
        .cornerRadius(3)
    }
    .padding(.vertical, 2)
    .accessibilityIdentifier("agent_status_\(agent.id)")
  }

  // ─── Voice state pill ─────────────────────────────────────────────────────

  private func voiceStatePill(label: String, icon: String, active: Bool, color: Color) -> some View {
    HStack(spacing: 4) {
      Image(systemName: icon)
        .font(.system(size: 9))
      Text(label)
        .font(.system(size: 11))
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(active ? color.opacity(0.15) : Color.secondary.opacity(0.08))
    .foregroundColor(active ? color : .secondary)
    .cornerRadius(6)
  }

  // ─── Spawn status bar ──────────────────────────────────────────────────

  private var spawnStatusBar: some View {
    HStack(spacing: 4) {
      Image(systemName: "bolt.fill")
        .font(.system(size: 9))
        .foregroundColor(.secondary)
      Text("\(appState.spawnActive) active / \(appState.spawnLimit) limit")
        .font(.system(size: 10))
        .foregroundColor(.secondary)
      Spacer()
    }
    .padding(.vertical, 2)
  }

  // ─── Task row ──────────────────────────────────────────────────────────

  private func taskRow(_ task: TaskItem) -> some View {
    HStack(spacing: 8) {
      if task.parentId != nil {
        Image(systemName: "arrow.turn.down.right")
          .font(.system(size: 9))
          .foregroundColor(.secondary)
          .frame(width: 12)
      }

      VStack(alignment: .leading, spacing: 1) {
        Text(task.label)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(2)

        HStack(spacing: 4) {
          Text(task.role.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.1))
            .cornerRadius(2)

          Text(taskTimeAgo(task.updatedAt))
            .font(.system(size: 9))
            .foregroundColor(.secondary.opacity(0.7))
        }
      }

      Spacer()

      reviewBadge(task)
      approvalBadge(task)

      Text(task.status.replacingOccurrences(of: "_", with: " ").uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(taskStatusColor(task.status))
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(taskStatusColor(task.status).opacity(0.1))
        .cornerRadius(3)
    }
    .padding(.leading, task.parentId != nil ? 16 : 0)
    .padding(.vertical, 4)
    .overlay(alignment: .bottomTrailing) {
      if task.repairCount >= 3 {
        Text("ESCALATED")
          .font(.system(size: 8, weight: .bold))
          .foregroundColor(.red)
          .padding(.horizontal, 4)
          .padding(.vertical, 1)
          .background(Color.red.opacity(0.1))
          .cornerRadius(2)
          .offset(y: 2)
      }
    }
    .accessibilityIdentifier("task_\(task.id)")
  }

}

// ─── Extracted helpers (SwiftLint type_body_length) ─────────────────────────

extension StatusPanel {
  func taskStatusColor(_ status: String) -> Color {
    switch status {
    case "inbox": return .secondary
    case "assigned": return .blue
    case "in_progress": return .orange
    case "review": return .purple
    case "done": return .green
    case "failed": return .red
    case "cancelled": return .gray
    case "awaiting_approval": return .yellow
    default: return .secondary
    }
  }

  func taskTimeAgo(_ date: Date) -> String {
    let seconds = Int(Date().timeIntervalSince(date))
    if seconds < 60 { return "just now" }
    if seconds < 3600 { return "\(seconds / 60)m ago" }
    if seconds < 86400 { return "\(seconds / 3600)h ago" }
    return "\(seconds / 86400)d ago"
  }

  func toolIcon(for name: String) -> String {
    switch name.lowercased() {
    case "bash", "shell": return "terminal"
    case "fileread", "read": return "doc.text"
    case "filewrite", "write": return "pencil"
    case "glob", "find": return "folder"
    case "grep": return "magnifyingglass"
    case "websearch", "search": return "globe"
    default: return "gearshape"
    }
  }

  func alertRow(_ alert: WatcherAlertItem) -> some View {
    HStack(spacing: 8) {
      Image(systemName: alertIcon(for: alert.alertType))
        .font(.system(size: 10))
        .foregroundColor(.red)

      Text(alert.message)
        .font(.system(size: 11))
        .foregroundColor(.primary)
        .lineLimit(2)

      Spacer()

      Text(alert.alertType.uppercased())
        .font(.system(size: 8, weight: .bold))
        .foregroundColor(.red)
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(Color.red.opacity(0.1))
        .cornerRadius(2)
    }
    .padding(.vertical, 3)
    .accessibilityIdentifier("alert_\(alert.id)")
  }

  func alertIcon(for type: String) -> String {
    switch type {
    case "stale": return "clock.badge.exclamationmark"
    case "loop": return "arrow.triangle.2.circlepath"
    case "runaway_spawn": return "exclamationmark.triangle"
    default: return "exclamationmark.circle"
    }
  }

  func validatorRow(_ entry: ValidatorEntry) -> some View {
    HStack(spacing: 8) {
      Image(systemName: entry.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
        .font(.system(size: 10))
        .foregroundColor(entry.passed ? .green : .red)

      VStack(alignment: .leading, spacing: 1) {
        Text(entry.name)
          .font(.system(size: 12, weight: .medium))
        Text("\(entry.durationMs)ms")
          .font(.system(size: 9))
          .foregroundColor(.secondary)
      }

      Spacer()

      Text(entry.passed ? "PASS" : "FAIL")
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(entry.passed ? .green : .red)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background((entry.passed ? Color.green : Color.red).opacity(0.1))
        .cornerRadius(3)
    }
    .padding(.vertical, 3)
    .accessibilityIdentifier("validator_\(entry.name)")
  }

  func agentColor(for agent: Agent) -> Color {
    switch agent.trigger {
    case "hourly": return .orange
    case "on-demand": return .blue
    default: return .green
    }
  }

  @ViewBuilder
  func approvalBadge(_ task: TaskItem) -> some View {
    if task.status == "awaiting_approval" {
      HStack(spacing: 2) {
        Image(systemName: "hand.raised.fill")
          .font(.system(size: 9))
          .foregroundColor(.orange)
        if let reason = task.approvalReason {
          Text(reason.prefix(20))
            .font(.system(size: 8))
            .foregroundColor(.orange)
            .lineLimit(1)
        }
      }
      .padding(.trailing, 4)
    }
  }

  @ViewBuilder
  func reviewBadge(_ task: TaskItem) -> some View {
    if let passed = task.lastReviewPassed {
      HStack(spacing: 2) {
        Image(systemName: passed ? "checkmark.circle.fill" : "xmark.circle.fill")
          .font(.system(size: 9))
          .foregroundColor(passed ? .green : .red)
        if task.repairCount > 0 {
          Text("\(task.repairCount)")
            .font(.system(size: 8, weight: .bold))
            .foregroundColor(.red)
        }
      }
      .padding(.trailing, 4)
    }
  }
}
