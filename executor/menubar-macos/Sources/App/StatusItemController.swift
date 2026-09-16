import AppKit
import Combine

/// The icon beside the clock and the menu behind it.
///
/// The menu is rebuilt from the model on every change, so it can never offer an
/// action the current state would refuse, and the icon is recomputed from the
/// same value — there is no second place that decides what the app is showing.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    /// Held strongly and for the app's whole life. An `NSStatusItem` that is not
    /// retained is removed from the menu bar the moment it is released, which
    /// looks exactly like an app that never started.
    private let statusItem: NSStatusItem
    private let controller: ExecutorController
    private let console: ConsoleWindowController
    private var observations: Set<AnyCancellable> = []

    init(controller: ExecutorController, console: ConsoleWindowController) {
        self.controller = controller
        self.console = console
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        // Named so macOS remembers where a person dragged it and keeps it across
        // launches instead of appending it at the end of a crowded menu bar.
        statusItem.autosaveName = "works.nessie.executor.menubar.status"
        statusItem.behavior = []
        statusItem.isVisible = true
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self
        controller.$model
            .sink { [weak self] model in Task { @MainActor in self?.render(model) } }
            .store(in: &observations)
        controller.$busy
            .sink { [weak self] _ in Task { @MainActor in self?.render(self?.controller.model) } }
            .store(in: &observations)
        render(controller.model)
    }

    private func render(_ model: MenuModel?) {
        guard let model, let button = statusItem.button else { return }
        let icon = menuIcon(for: model)
        button.image = StatusItemIcon.image(for: icon)
        button.imagePosition = .imageOnly
        button.toolTip = menuHeader(for: model)
        button.setAccessibilityLabel(menuHeader(for: model))
        statusItem.isVisible = true
        rebuildMenu(model)
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
        // nobody can find. Each one opens the single window on that section.
        for section in ConsoleSection.allCases {
            let item = NSMenuItem(
                title: section.menuTitle,
                action: #selector(openSection(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = section.rawValue
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

    @objc private func openSection(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let section = ConsoleSection(rawValue: raw)
        else { return }
        console.show(section)
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
