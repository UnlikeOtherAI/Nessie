import AppKit
import SwiftUI

enum Panel: String, CaseIterable {
    case settings
    case reach
    case tools

    var title: String {
        switch self {
        case .settings: return "Nessie Executor Settings"
        case .reach: return "Where it can reach"
        case .tools: return "Tools it can run"
        }
    }
}

/// One window per surface, reused. An app with no Dock icon has no window menu,
/// so every panel is brought to the front and given key focus when it is asked
/// for again — otherwise a second click on a menu line would appear to do
/// nothing while the window sat behind Safari.
@MainActor
final class PanelPresenter: NSObject, NSWindowDelegate {
    private var windows: [Panel: NSWindow] = [:]
    private let controller: ExecutorController

    init(controller: ExecutorController) {
        self.controller = controller
    }

    func show(_ panel: Panel) {
        controller.refresh()
        if let existing = windows[panel] {
            NSApp.activate(ignoringOtherApps: true)
            existing.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 460),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = panel.title
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.contentView = NSHostingView(rootView: root(for: panel))
        windows[panel] = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @ViewBuilder
    private func root(for panel: Panel) -> some View {
        switch panel {
        case .settings: SettingsPanel().environmentObject(controller)
        case .reach: ReachPanel().environmentObject(controller)
        case .tools: ToolsPanel().environmentObject(controller)
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        windows = windows.filter { $0.value !== window }
    }
}
