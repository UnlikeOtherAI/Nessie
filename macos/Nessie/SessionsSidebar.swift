import SwiftUI

// ─── Sessions sidebar ─────────────────────────────────────────────────────────

struct SessionsSidebar: View {
  @EnvironmentObject var appState: AppState
  @Binding var statusPanelOpen: Bool

  private var groupedSessions: [(String, [Session])] {
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: Date())
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today

    var groups: [String: [Session]] = [:]

    for session in appState.sessions {
      let startOfSessionDay = calendar.startOfDay(for: session.updatedAt)
      let label: String
      if startOfSessionDay >= today {
        label = "Today"
      } else if startOfSessionDay >= yesterday {
        label = "Yesterday"
      } else {
        label = "Earlier"
      }
      groups[label, default: []].append(session)
    }

    let order = ["Today", "Yesterday", "Earlier"]
    return groups.sorted { lhsGroup, rhsGroup in
      let lhsIndex = order.firstIndex(of: lhsGroup.key) ?? 99
      let rhsIndex = order.firstIndex(of: rhsGroup.key) ?? 99
      return lhsIndex < rhsIndex
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {

      // ── Sessions ──────────────────────────────────────────────────────────
      sidebarSection("CONVERSATIONS") {
        if appState.sessions.isEmpty {
          emptyHint("No conversations yet.\nSend a message to start one.")
        } else {
          ForEach(groupedSessions, id: \.0) { group, sessions in
            sectionHeader(group)
            ForEach(sessions) { session in
              sessionRow(session)
            }
          }
        }
      }

      Spacer()
      Divider().padding(.horizontal, 12)

      // ── Agents ─────────────────────────────────────────────────────────────
      sidebarSection("AGENTS") {
        ForEach(appState.agents, id: \.id) { agent in
          agentRow(agent)
        }
      }

      Divider().padding(.horizontal, 12)

      // ── Status ─────────────────────────────────────────────────────────────
      statusBar
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .accessibilityIdentifier("sessions_sidebar")
  }

  // ─── Section containers ─────────────────────────────────────────────────────

  @ViewBuilder
  private func sidebarSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .font(.system(size: 10, weight: .semibold))
        .foregroundColor(.secondary)
        .padding(.horizontal, 12)
        .padding(.top, title == "CONVERSATIONS" ? 16 : 12)
        .padding(.bottom, 4)
      content()
    }
  }

  @ViewBuilder
  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(.system(size: 9, weight: .bold))
      .foregroundColor(.secondary.opacity(0.7))
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, 2)
  }

  // ─── Session row ────────────────────────────────────────────────────────────

  private func sessionRow(_ session: Session) -> some View {
    let isSelected = appState.selectedSession?.id == session.id

    return HStack(alignment: .top, spacing: 8) {
      // Activity dot
      Circle()
        .fill(session.updatedAt > Date().addingTimeInterval(-60) ? Color.green : Color.gray.opacity(0.4))
        .frame(width: 7, height: 7)
        .padding(.top, 5)

      VStack(alignment: .leading, spacing: 2) {
        Text(session.name)
          .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
          .foregroundColor(isSelected ? .primary : .primary.opacity(0.85))
          .lineLimit(1)

        if !session.preview.isEmpty {
          Text(session.preview)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .lineLimit(1)
        }

        HStack(spacing: 4) {
          Text(timeLabel(for: session.updatedAt))
            .font(.system(size: 10))
            .foregroundColor(.secondary.opacity(0.7))

          if session.messageCount > 0 {
            Text("·")
              .foregroundColor(.secondary.opacity(0.5))
            Text("\(session.messageCount) messages")
              .font(.system(size: 10))
              .foregroundColor(.secondary.opacity(0.7))
          }
        }
      }

      Spacer()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
    .cornerRadius(6)
    .contentShape(Rectangle())
    .onTapGesture { appState.selectSession(session) }
    .accessibilityIdentifier("session_row_\(session.id)")
  }

  // ─── Agent row ─────────────────────────────────────────────────────────────

  private func agentRow(_ agent: Agent) -> some View {
    let isSelected = appState.selectedAgent?.id == agent.id
    let dotColor: Color = {
      switch agent.trigger {
      case "hourly": return .orange
      case "on-demand": return .blue
      default: return .green
      }
    }()

    return HStack(spacing: 8) {
      Circle()
        .fill(dotColor)
        .frame(width: 7, height: 7)

      VStack(alignment: .leading, spacing: 1) {
        Text(agent.name)
          .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
          .foregroundColor(isSelected ? .primary : .primary.opacity(0.85))
          .lineLimit(1)

        Text(agent.responsibility)
          .font(.system(size: 10))
          .foregroundColor(.secondary)
          .lineLimit(1)
      }

      Spacer()

      Text(agent.trigger.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundColor(.secondary)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Color.secondary.opacity(0.1))
        .cornerRadius(3)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
    .cornerRadius(6)
    .contentShape(Rectangle())
    .onTapGesture { appState.selectAgent(agent) }
    .accessibilityIdentifier("agent_row_\(agent.id)")
  }

  // ─── Status bar ────────────────────────────────────────────────────────────

  private var statusBar: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(appState.isBackendReachable ? Color.green : Color.red)
        .frame(width: 6, height: 6)

      Text(appState.isBackendReachable ? "Nessie connected" : "Nessie offline")
        .font(.system(size: 11))
        .foregroundColor(.secondary)

      Spacer()

      if appState.isListening {
        Image(systemName: "mic.fill")
          .font(.system(size: 10))
          .foregroundColor(.green)
      }
      if appState.isThinking {
        Image(systemName: "ellipsis")
          .font(.system(size: 10))
          .foregroundColor(.orange)
      }

      Button {
        statusPanelOpen.toggle()
      } label: {
        Image(systemName: statusPanelOpen ? "sidebar.right" : "sidebar.leading")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("toggle_status_panel")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private func timeLabel(for date: Date) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: date, relativeTo: Date())
  }

  @ViewBuilder
  private func emptyHint(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12))
      .foregroundColor(.secondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .multilineTextAlignment(.leading)
  }
}
