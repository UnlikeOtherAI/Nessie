import AppKit
import ServiceManagement
import SwiftUI

/// Pairing, the workspace folder, and starting at login.
struct SettingsSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @State private var invitation = ""
    @State private var chosenWorkspace: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch controller.model.pairing {
            case let .unavailable(reason):
                UnavailableNotice(reason: reason)
            case .unpaired:
                pairingForm
            case let .paired(description):
                pairedSummary(description)
                Divider()
                workspaceSection(description)
            }
            Divider()
            launchAtLoginSection
        }
    }

    // MARK: - Pairing

    private var pairingForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair with Nessie").font(.headline)
            FactRow(label: "API origin this build may pair with", value: controller.apiOrigin)
            Text(
                "In Nessie, open Agents → Executors, create an executor, and copy the pairing command "
                    + "or invitation link it offers. It carries the enrollment id and the one-time "
                    + "challenge; both are read here and never put on the command line."
            )
            .font(.callout)
            .foregroundStyle(.secondary)

            TextEditor(text: $invitation)
                .font(.body.monospaced())
                .frame(height: 72)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            HStack(spacing: 10) {
                Button("Choose workspace folder…") {
                    if let selected = pickFolder() { chosenWorkspace = selected }
                }
                Text(chosenWorkspace?.path ?? "No folder chosen")
                    .font(.callout)
                    .foregroundStyle(chosenWorkspace == nil ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Text(
                "The folder is the one read-only root this executor is paired against. Its contents stay "
                    + "on this Mac; file content and bounded tool output reach Nessie and the configured "
                    + "model provider only when an operation you reviewed runs."
            )
            .font(.callout)
            .foregroundStyle(.secondary)

            Button("Pair this Mac") {
                guard let workspace = chosenWorkspace else {
                    controller.fail("Choose the folder this executor may read before pairing.")
                    return
                }
                controller.pair(invitationText: invitation, workspaceRoot: workspace.path)
            }
            .keyboardShortcut(.defaultAction)
            .disabled(controller.busy)
        }
    }

    private func pairedSummary(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paired").font(.headline)
            FactRow(label: "Executor", value: description.executorId)
            FactRow(label: "Nessie API", value: description.apiBaseUrl)
            if let fingerprint = controller.pendingFingerprint {
                Label(
                    "Confirm fingerprint \(fingerprint) in Nessie, then start the executor from the "
                        + "menu bar icon. Nothing runs until somebody confirms it there.",
                    systemImage: "checkmark.shield"
                )
                .font(.callout)
                .textSelection(.enabled)
            }
            PolicyReviewNote(revision: description.policy.revision)
        }
    }

    // MARK: - Workspace

    // The workspace is one folder today. It is becoming several named folders,
    // at which point the picker below becomes an add/remove list and this
    // section hands that list to `configure` the same way it hands one path now.
    private func workspaceSection(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Workspace folder").font(.headline)
            FactRow(label: "Read-only root", value: description.reach.workspaceRoot)
            Button("Change workspace folder…") {
                guard let selected = pickFolder() else { return }
                controller.proposePolicy(workspaceRoot: selected.path)
            }
            .disabled(controller.busy)
            Text(
                "Changing the folder is refused while any local draft or sandbox exists: remove every "
                    + "local draft and stop every sandbox first. The new folder lands as a policy "
                    + "revision a person reviews in Nessie."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }

    private func pickFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Select the executor's read-only workspace"
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        NSApp.activate(ignoringOtherApps: true)
        return panel.runModal() == .OK ? panel.url : nil
    }

    // MARK: - Launch at login

    private var launchAtLoginSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Start at login").font(.headline)
            Toggle("Open Nessie Executor when I log in", isOn: launchAtLoginBinding)
            Text(
                "The executor daemon is this app's own child process, held alive by a pipe it watches. "
                    + "Starting at login is the only way it comes back after a restart — and quitting "
                    + "this app always stops it."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }

    private var launchAtLoginBinding: Binding<Bool> {
        Binding(
            get: { LaunchAtLogin.isEnabled },
            set: { enabled in
                if let refusal = LaunchAtLogin.set(enabled) {
                    controller.fail(refusal.message)
                }
            }
        )
    }
}

/// `SMAppService` is the supported way a menu bar app registers itself, and the
/// only one that survives a move of the bundle. Its refusals are surfaced rather
/// than swallowed: a toggle that silently did nothing would be worse than none.
enum LaunchAtLogin {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func set(_ enabled: Bool) -> ExecutorRefusal? {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            if SMAppService.mainApp.status == .requiresApproval {
                return ExecutorRefusal(
                    "macOS is holding this request: allow Nessie Executor in System Settings → "
                        + "General → Login Items & Extensions."
                )
            }
            return ExecutorRefusal(
                "macOS refused to change the login item for Nessie Executor: "
                    + error.localizedDescription
            )
        }
    }
}
