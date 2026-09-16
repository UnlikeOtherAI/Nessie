import SwiftUI

/// Where it can reach: the two facts of the local state that bound this
/// executor's view of the world — the read-only workspace, and the origins its
/// guest browser may open. Both are read from `describe`; neither is inferred.
struct ReachSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @EnvironmentObject private var selection: ConsoleSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch controller.model.pairing {
            case let .unavailable(reason):
                UnavailableNotice(reason: reason)
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

    // One folder today, several named folders shortly. The list below is already
    // a list so that the second one does not need a different shape here; only
    // its rows and the add/remove controls arrive with that contract.
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
            // The picker itself lives in Settings; this is its doorway rather
            // than a second copy of it.
            Button("Change it in Settings") { selection.section = .settings }
        }
    }

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
