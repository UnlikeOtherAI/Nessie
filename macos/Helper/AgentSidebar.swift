import SwiftUI

struct AgentSidebar: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("AGENTS")
        .font(.caption)
        .fontWeight(.semibold)
        .foregroundColor(.secondary)
        .padding(.horizontal, 12)
        .padding(.top, 16)
        .padding(.bottom, 8)

      ForEach(appState.agents) { agent in
        AgentRow(agent: agent)
      }

      Spacer()

      Divider()
        .padding(.horizontal, 12)

      Button {
        // Add new agent - placeholder
      } label: {
        Label("New Agent", systemImage: "plus")
          .font(.system(size: 13))
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
      .padding(12)
    }
    .background(Color(nsColor: .controlBackgroundColor))
  }
}

struct AgentRow: View {
  let agent: Agent
  @EnvironmentObject var appState: AppState

  private var isSelected: Bool {
    appState.selectedAgent.id == agent.id
  }

  var body: some View {
    Button {
      appState.selectedAgent = agent
    } label: {
      HStack {
        Circle()
          .fill(agent.type == "orchestrator" ? Color.green : Color.blue)
          .frame(width: 8, height: 8)
        Text(agent.name)
          .font(.system(size: 13))
        Spacer()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
      .cornerRadius(6)
    }
    .buttonStyle(.plain)
  }
}
