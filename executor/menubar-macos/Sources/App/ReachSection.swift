import AppKit
import SwiftUI

/// Where it can reach: the named folders that bound this executor's view of the
/// filesystem, and the origins its guest browser may open. Both are read from
/// `describe`; neither is inferred.
struct ReachSection: View {
    @EnvironmentObject private var controller: ExecutorController

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch controller.model.pairing {
            case let .unavailable(reason):
                UnavailableNotice(reason: reason)
            case .unpaired:
                UnpairedNotice()
            case let .paired(description):
                folders(description)
                Divider()
                origins(description)
                Divider()
                PolicyReviewNote(revision: description.policy.revision)
            }
        }
    }

    // MARK: - Folders

    private func folders(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Folders", systemImage: "folder").font(.headline)
            Text(
                "These are the only parts of this Mac's filesystem the executor sees. A folder's name "
                    + "starts every path an agent writes, so `\(exampleName(description))/README.md` "
                    + "means that file inside that folder."
            )
            .font(.callout)
            .foregroundStyle(.secondary)

            ForEach(description.reach.folders) { folder in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(folder.name).font(.body.monospaced().bold()).textSelection(.enabled)
                        Text(folder.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    Button("Remove") { remove(folder.name, from: description) }
                        .disabled(controller.busy)
                }
                .padding(.vertical, 1)
            }

            Button("Add a folder…") { add(to: description) }
                .disabled(controller.busy)

            Label(
                description.sandbox.promotionHelperConfigured
                    ? "A promotion helper is configured: reviewed changes can be written back to these "
                        + "folders."
                    : "No promotion helper is configured. Writes land in daemon-owned copy-on-write "
                        + "scratch and nothing is ever written back to these folders.",
                systemImage: description.sandbox.promotionHelperConfigured ? "arrow.up.doc" : "lock.doc"
            )
            .font(.callout)

            Label(description.guestSessionNote, systemImage: "cube.transparent")
                .font(.callout)
                .foregroundStyle(
                    description.reach.guestSessions == .available ? .secondary : .primary
                )

            Text(
                "Adding or removing a folder is refused while any local draft or sandbox exists: "
                    + "remove every local draft and stop every sandbox first."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }

    private func exampleName(_ description: ExecutorDescription) -> String {
        description.reach.folders.first?.name ?? "workspace"
    }

    private func add(to description: ExecutorDescription) {
        let panel = NSOpenPanel()
        panel.message = "Choose a folder this executor may read"
        panel.prompt = "Add"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let chosen = panel.url else { return }
        switch WorkspaceFolder.validate(
            adding: chosen.path,
            named: nil,
            to: description.reach.folders
        ) {
        case let .failure(refusal):
            controller.fail(refusal.message)
        case let .success(folders):
            controller.proposePolicy(workspaceFolders: folders)
        }
    }

    private func remove(_ name: String, from description: ExecutorDescription) {
        switch WorkspaceFolder.validate(removing: name, from: description.reach.folders) {
        case let .failure(refusal):
            controller.fail(refusal.message)
        case let .success(folders):
            controller.proposePolicy(workspaceFolders: folders)
        }
    }

    // MARK: - Browser origins

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
