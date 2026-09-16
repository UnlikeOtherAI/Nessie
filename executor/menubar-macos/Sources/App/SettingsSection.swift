import AppKit
import ServiceManagement
import SwiftUI

/// Pairing, the workspace folder, and starting at login.
struct SettingsSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @EnvironmentObject private var selection: ConsoleSelection
    @State private var invitation = ""
    @State private var chosenWorkspace: URL?
    /// Nil until a person picks: the starting choice depends on the build, and a
    /// `@State` default cannot read the environment object that knows which one
    /// this is.
    @State private var target: PairingTarget?
    @State private var typedOrigin = ""

    /// Which Nessie the pairing panel is pointed at. `custom` is never a label a
    /// person reads on its own — the panel shows the host underneath it.
    private enum PairingTarget: Hashable {
        case preset(String)
        case localDevelopment
        case custom
    }

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
                foldersSection(description)
            }
            Divider()
            launchAtLoginSection
        }
    }

    // MARK: - Pairing

    /// The choices offered, in the order they are offered. A release build never
    /// gains the local development origin: it is a compile-time fact, not a
    /// setting, and a release that could be talked into plain HTTP would not be
    /// a release.
    private var targets: [PairingTarget] {
        ApprovedAPIOrigin.presets.map { PairingTarget.preset($0.id) }
            + (controller.isDevelopmentBuild ? [.localDevelopment] : [])
            + [.custom]
    }

    private var selectedTarget: PairingTarget {
        target ?? (controller.isDevelopmentBuild
            ? .localDevelopment
            : .preset(ApprovedAPIOrigin.presets[0].id))
    }

    private func name(of target: PairingTarget) -> String {
        switch target {
        case let .preset(id):
            return ApprovedAPIOrigin.preset(id)?.label ?? id
        case .localDevelopment:
            return "Local development"
        case .custom:
            return "A Nessie you host yourself"
        }
    }

    /// What the choice currently means, before approval. A preset is named by
    /// its id — `ApprovedAPIOrigin` resolves it to the pinned origin, so this
    /// panel never carries a second copy of those URLs.
    private var chosenOrigin: String {
        switch selectedTarget {
        case let .preset(id):
            return id
        case .localDevelopment:
            return ApprovedAPIOrigin.localDevelopment
        case .custom:
            return typedOrigin
        }
    }

    private var pairingForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair with Nessie").font(.headline)

            Picker("Which Nessie", selection: Binding(
                get: { selectedTarget },
                set: { target = $0 }
            )) {
                ForEach(targets, id: \.self) { candidate in
                    Text(name(of: candidate)).tag(candidate)
                }
            }
            .pickerStyle(.radioGroup)

            if selectedTarget == .custom {
                TextField("https://nessie.example.com", text: $typedOrigin)
                    .font(.body.monospaced())
                    .textFieldStyle(.roundedBorder)
            }

            pairingTargetVerdict

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
                controller.pair(
                    invitationText: invitation,
                    chosenOrigin: chosenOrigin,
                    workspaceRoot: workspace.path
                )
            }
            .keyboardShortcut(.defaultAction)
            .disabled(controller.busy || approvedOrigin == nil)
        }
    }

    private var approvedOrigin: String? {
        try? controller.approvedOrigin(
            invitationText: invitation,
            chosenOrigin: chosenOrigin
        ).get()
    }

    /// The host this Mac is about to hand a machine key to, on screen before the
    /// button is pressed. An invitation that names its own `--api` is what will
    /// be used, and this says so rather than letting the picker imply otherwise.
    @ViewBuilder
    private var pairingTargetVerdict: some View {
        let named = InvitationParser.apiBaseUrl(in: invitation)
        switch controller.approvedOrigin(invitationText: invitation, chosenOrigin: chosenOrigin) {
        case let .success(origin):
            VStack(alignment: .leading, spacing: 2) {
                FactRow(
                    label: named == nil
                        ? "Pairing with"
                        : "Pairing with, as named by this invitation",
                    value: "\(ApprovedAPIOrigin.label(for: origin)) — \(origin)"
                )
            }
        case let .failure(refusal):
            if selectedTarget == .custom && typedOrigin.isEmpty && named == nil {
                Text("Enter the address of the Nessie you host, such as https://nessie.example.com.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Label(refusal.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
    }

    private func pairedSummary(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paired").font(.headline)
            FactRow(label: "Executor", value: description.executorId)
            // Named and spelled out: an already-paired executor has to be able
            // to say which Nessie it belongs to, and the host is the fact that
            // answers it.
            FactRow(
                label: "Paired with \(ApprovedAPIOrigin.label(for: description.apiBaseUrl))",
                value: description.apiBaseUrl
            )
            if let fingerprint = controller.pendingFingerprint {
                Label(
                    "Confirm fingerprint \(fingerprint) at \(description.apiBaseUrl), then start the "
                        + "executor from the menu bar icon. Nothing runs until somebody confirms it "
                        + "there.",
                    systemImage: "checkmark.shield"
                )
                .font(.callout)
                .textSelection(.enabled)
            }
            PolicyReviewNote(revision: description.policy.revision)
        }
    }

    // MARK: - Folders

    /// Settings shows what this executor reaches and hands the editing to the
    /// surface that owns it. There is one add/remove list of folders and it
    /// lives in "Where it can reach"; a second picker here would be a second
    /// implementation of the same thing.
    private func foldersSection(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Folders it may read").font(.headline)
            ForEach(description.reach.folders) { folder in
                FactRow(label: folder.name, value: folder.path)
            }
            Button("Add or remove folders…") { selection.section = .reach }
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
