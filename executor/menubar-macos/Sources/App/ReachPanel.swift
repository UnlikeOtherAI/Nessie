import SwiftUI

/// Where it can reach: the two facts of the local state that bound this
/// executor's view of the world — the one read-only folder, and the origins its
/// guest browser may open. Both are read from `describe`; neither is inferred.
struct ReachPanel: View {
    @EnvironmentObject private var controller: ExecutorController

    var body: some View {
        PanelChrome(
            title: "Where it can reach",
            subtitle: "Everything outside this list is outside the executor's reach."
        ) {
            switch controller.model.pairing {
            case let .unavailable(reason):
                Label(reason, systemImage: "exclamationmark.triangle.fill").font(.callout)
            case .unpaired:
                UnpairedNotice()
            case let .paired(description):
                workspace(description)
                Divider()
                origins(description)
                Divider()
                PolicyReviewNote(revision: description.policy.revision)
            }
        }
    }

    private func workspace(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Workspace", systemImage: "folder").font(.headline)
            FactRow(label: "The one read-only root", value: description.reach.workspaceRoot)
            Text(
                "This is the only part of this Mac's filesystem the executor sees. Writes land in "
                    + "daemon-owned copy-on-write scratch, never in this folder, unless a separately "
                    + "reviewed promotion helper is configured."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            Label(
                description.sandbox.promotionHelperConfigured
                    ? "A promotion helper is configured: reviewed changes can be written back."
                    : "No promotion helper is configured, so nothing is ever written back to this folder.",
                systemImage: description.sandbox.promotionHelperConfigured ? "arrow.up.doc" : "lock.doc"
            )
            .font(.callout)
            Button("Change workspace folder…") { controller.refusal = ReachPanel.workspaceDoorway }
                .help("The workspace folder is chosen in Settings, where the picker lives.")
        }
    }

    /// The doorway rather than a second picker: one surface owns choosing the
    /// folder, and this panel points at it instead of forking it.
    private static let workspaceDoorway =
        "The workspace folder is chosen in Settings → Workspace folder, from the menu bar icon."

    private func origins(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Browser origins", systemImage: "globe").font(.headline)
            if description.reach.allowedOrigins.isEmpty {
                Text(
                    description.sandbox.browserConfigured
                        ? "No origin is allowed, so the guest browser can open nothing."
                        : "No guest browser is configured on this Mac, so there is nothing to reach and "
                            + "browser operations cannot be enabled."
                )
                .font(.callout)
            } else {
                ForEach(description.reach.allowedOrigins, id: \.self) { origin in
                    Text(origin).font(.body.monospaced()).textSelection(.enabled)
                }
            }
            Text(
                "Allowed origins belong to the owner-only browser sandbox, which is configured together "
                    + "with its kernel, VM helper and guest runtime bundle — `nessie-executor "
                    + "configure-browser`. This app does not hold those owner-only paths, so it shows "
                    + "the list and does not pretend it can widen it."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }
}
