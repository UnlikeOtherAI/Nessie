import AppKit
import Combine

/// The icon beside the clock and the menu behind it.
///
/// The menu is rebuilt from the model on every change, so it can never offer an
/// action the current state would refuse, and the icon is recomputed from the
/// same value — there is no second place that decides what the app is showing.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let controller: ExecutorController
    private let panels: PanelPresenter
    private var observation: AnyCancellable?

    init(controller: ExecutorController, panels: PanelPresenter) {
        self.controller = controller
        self.panels = panels
        super.init()
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self
        observation = controller.$model.sink { [weak self] model in
            Task { @MainActor in self?.render(model) }
        }
        render(controller.model)
    }

    private func render(_ model: MenuModel) {
        guard let button = statusItem.button else { return }
        let icon = menuIcon(for: model)
        button.image = StatusItemController.image(for: icon)
        button.image?.isTemplate = icon == .stopped
        button.contentTintColor = StatusItemController.tint(for: icon)
        button.toolTip = menuHeader(for: model)
        button.setAccessibilityLabel(menuHeader(for: model))
        rebuildMenu(model)
    }

    /// A shape per state, not a colour per state: the menu bar is the one place
    /// on macOS where a person may be looking at a monochrome rendering, so the
    /// symbol itself has to differ before the tint does.
    private static func image(for icon: MenuIcon) -> NSImage? {
        let name: String
        let label: String
        switch icon {
        case .stopped:
            name = "circle.dashed"
            label = "Nessie Executor is stopped"
        case .running:
            name = "circle.circle.fill"
            label = "Nessie Executor is running"
        case .needsAttention:
            name = "exclamationmark.triangle.fill"
            label = "Nessie Executor needs attention"
        }
        return NSImage(systemSymbolName: name, accessibilityDescription: label)
    }

    private static func tint(for icon: MenuIcon) -> NSColor? {
        switch icon {
        case .stopped: return nil
        case .running: return .systemGreen
        case .needsAttention: return .systemOrange
        }
    }

    private func rebuildMenu(_ model: MenuModel) {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()
        let header = NSMenuItem(title: menuHeader(for: model), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let start = NSMenuItem(title: "Start executor", action: #selector(startDaemon), keyEquivalent: "")
        start.target = self
        start.isEnabled = startIsAvailable(for: model) && !controller.busy
        menu.addItem(start)

        let stop = NSMenuItem(title: "Stop executor", action: #selector(stopDaemon), keyEquivalent: "")
        stop.target = self
        stop.isEnabled = stopIsAvailable(for: model) && !controller.busy
        menu.addItem(stop)
        menu.addItem(.separator())

        // The three surfaces this app exists for. They are always offered, even
        // unpaired: "where it can reach" answering "nothing yet, pair this Mac"
        // is the answer a person came for, and a hidden menu line is a capability
        // nobody can find.
        for (title, panel) in [
            ("Settings…", Panel.settings),
            ("Where it can reach…", Panel.reach),
            ("Tools it can run…", Panel.tools),
        ] {
            let item = NSMenuItem(title: title, action: #selector(openPanel(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = panel.rawValue
            menu.addItem(item)
        }
        menu.addItem(.separator())

        let nessie = NSMenuItem(title: "Open Nessie", action: #selector(openNessie), keyEquivalent: "")
        nessie.target = self
        menu.addItem(nessie)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: quitLabel(for: model), action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    func menuWillOpen(_ menu: NSMenu) {
        controller.refresh()
    }

    @objc private func startDaemon() { controller.startDaemon() }

    @objc private func stopDaemon() { controller.stopDaemon() }

    @objc private func openPanel(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let panel = Panel(rawValue: raw) else { return }
        panels.show(panel)
    }

    @objc private func openNessie() {
        // The admin origin that matches this build's API origin. A development
        // build opens the local admin; a release opens the hosted one.
        let url = controller.isDevelopmentBuild
            ? URL(string: "http://localhost:5455/agents/executors")
            : URL(string: "https://app.nessie.works/agents/executors")
        if let url { NSWorkspace.shared.open(url) }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
