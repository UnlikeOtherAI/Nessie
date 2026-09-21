import AppKit
import SwiftUI

/// The local half of pairing: display a code, then confirm the named destination.
struct PairingSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @EnvironmentObject private var pairing: ExecutorPairingController
    @State private var chosenWorkspace: URL?
    @State private var target: String?
    @State private var typedOrigin = ""
    @State private var replacing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let state = pairing.state, state.isPending {
                PairingAttemptView(
                    state: state,
                    busy: pairing.busy || controller.busy,
                    confirm: { pairing.confirm(state) },
                    cancel: { pairing.cancel() },
                    openNessie: { NSWorkspace.shared.open(controller.nessieExecutorsURL) }
                )
            } else if controller.model.description != nil && !replacing {
                pairedSummary
            } else {
                pairingForm
            }
            if let failure = pairing.failure {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                Button("Try again") { pairing.restore() }
                    .disabled(pairing.busy)
            }
        }
        .onChange(of: pairing.state?.status) { _, status in
            if status == .waiting || status == .paired { replacing = false }
        }
    }

    private var selectedTarget: String {
        target ?? (controller.isDevelopmentBuild ? "local" : "nessie")
    }

    private var chosenOrigin: String {
        switch selectedTarget {
        case "custom": return typedOrigin
        case "local": return ApprovedAPIOrigin.localDevelopment
        default: return selectedTarget
        }
    }

    private var chosenFolder: URL? {
        chosenWorkspace ?? controller.model.description?.reach.folders.first.map {
            URL(fileURLWithPath: $0.path)
        }
    }

    private var pairingForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(replacing ? "Replace this pairing?" : "Pair this Mac").font(.headline)
            if replacing {
                Text("This Mac is already paired to \(pairing.state?.connectionName ?? "Nessie"). "
                    + "Replacing it closes that connection before creating a new code.")
                    .font(.callout)
            } else if pairing.state?.status == .expired {
                Text("The code expired. Get a new one to continue.").font(.callout)
            }
            Picker("Which Nessie", selection: Binding(
                get: { selectedTarget }, set: { target = $0 }
            )) {
                ForEach(ApprovedAPIOrigin.presets) { preset in
                    Text(preset.label).tag(preset.id)
                }
                if controller.isDevelopmentBuild { Text("Local development").tag("local") }
                Text("A Nessie you host yourself").tag("custom")
            }
            if selectedTarget == "custom" {
                TextField("Your Nessie address", text: $typedOrigin)
                    .textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 10) {
                Button("Choose folder…") { chooseFolder() }
                Text(chosenFolder?.lastPathComponent ?? "No folder chosen")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text("Choose the folder this Mac may read for you. You can add more folders later.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button(replacing ? "Replace and get a code" : "Get pairing code") {
                    guard let folder = chosenFolder else { return }
                    pairing.begin(origin: chosenOrigin, workspace: folder.path, replace: replacing)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(pairing.busy || controller.busy || chosenFolder == nil || !originIsValid)
                if replacing { Button("Cancel") { replacing = false } }
            }
        }
    }

    private var originIsValid: Bool {
        (try? ApprovedAPIOrigin.approve(chosenOrigin, isDevelopmentBuild: controller.isDevelopmentBuild).get()) != nil
    }

    private var pairedSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Paired", systemImage: "checkmark.circle.fill").font(.headline)
            if let name = pairing.state?.organizationName {
                FactRow(label: "Organisation", value: name)
                FactRow(label: "Team", value: pairing.state?.teamName ?? "No team selected")
            } else {
                Text("Checking your organisation and team…").foregroundStyle(.secondary)
            }
            if let machine = pairing.state?.machineName { FactRow(label: "Machine", value: machine) }
            Button("Replace pairing…") { replacing = true }
                .disabled(pairing.busy || controller.busy || controller.model.daemon == .stopping)
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.message = "Choose the folder Nessie may read for you"
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK { chosenWorkspace = panel.url }
    }
}

/// The visible pending attempt is a value. Its confirmation closure captures
/// this exact claim, so a background refresh cannot substitute another one.
struct PairingAttemptView: View {
    let state: ExecutorPairing
    let busy: Bool
    let confirm: () -> Void
    let cancel: () -> Void
    let openNessie: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(state.expiration?.timeIntervalSince(context.date) ?? 0))
            VStack(alignment: .leading, spacing: 12) {
                if seconds == 0 {
                    Text("This code has expired").font(.headline)
                    Text("Cancel this attempt, then get a new code.").font(.callout)
                } else if state.status == .confirmation {
                    confirmation(state)
                    Button("Confirm and connect", action: confirm)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy)
                } else {
                    Text("Enter this code in Nessie").font(.headline)
                    Text("Open Agents → Executors → Pair executor.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    PairingCodeBoxes(code: state.code ?? "")
                    Button("Open Nessie", action: openNessie)
                }
                if seconds > 0 {
                    Text("Expires in \(seconds / 60):\(String(format: "%02d", seconds % 60))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Button("Cancel pairing", action: cancel)
                    .disabled(busy)
            }
        }
    }

    private func confirmation(_ state: ExecutorPairing) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect this Mac?").font(.headline)
            FactRow(label: "Organisation", value: state.organizationName ?? "")
            FactRow(label: "Team", value: state.teamName ?? "No team selected")
            if let fingerprint = state.fingerprint { FactRow(label: "Machine fingerprint", value: fingerprint) }
            Text("Confirm only if this is the organisation and team you chose in Nessie.")
                .font(.callout)
        }
    }

}

struct PairingCodeBoxes: View {
    let code: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(code.enumerated()), id: \.offset) { _, digit in
                Text(String(digit))
                    .font(.system(size: 28, weight: .semibold, design: .monospaced))
                    .frame(width: 44, height: 52)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Pairing code")
        .accessibilityValue(code.map(String.init).joined(separator: ", "))
    }
}
