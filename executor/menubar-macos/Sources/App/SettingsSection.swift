import AppKit
import ServiceManagement
import SwiftUI

/// Pairing lives here; folder editing has its one owner in the reach section.
struct SettingsSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @EnvironmentObject private var selection: ConsoleSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if case let .unavailable(reason) = controller.model.pairing {
                UnavailableNotice(reason: reason)
            } else {
                PairingSection()
                if let description = controller.model.description {
                    Divider()
                    foldersSection(description)
                }
            }
            Divider()
            launchAtLoginSection
        }
    }

    private func foldersSection(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Folders it may read").font(.headline)
            ForEach(description.reach.folders) { folder in
                FactRow(label: folder.name, value: folder.path)
            }
            Button("Add or remove folders…") { selection.section = .reach }
        }
    }

    private var launchAtLoginSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Start at login").font(.headline)
            Toggle("Open Nessie Executor when I log in", isOn: launchAtLoginBinding)
            Text("Your paired executor starts when this app opens. Quitting the app stops it.")
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

/// SMAppService owns launch-at-login registration; its refusal stays visible.
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
            return ExecutorRefusal("macOS could not change this setting. Check Login Items in System Settings.")
        }
    }
}
