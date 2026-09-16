import AppKit

/// A status-bar-only app: `LSUIElement` keeps it out of the Dock and the app
/// switcher, so the icon beside the clock is the whole of its presence — which
/// is why every one of its three surfaces hangs off that icon's menu.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: ExecutorController?
    private var statusItem: StatusItemController?
    private var panels: PanelPresenter?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = ExecutorController(isDevelopmentBuild: AppBuild.isDevelopment)
        let panels = PanelPresenter(controller: controller)
        self.controller = controller
        self.panels = panels
        self.statusItem = StatusItemController(controller: controller, panels: panels)
        controller.start()
    }

    /// Quitting stops the daemon, and waits for it: this app's daemon is its own
    /// child, and a sandbox mid-teardown is waited for rather than killed.
    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

enum AppBuild {
    /// The one switch that decides which API origin this build may pair with and
    /// whether a state directory may be overridden. It is a compile-time fact,
    /// not a setting: a release that could be talked into development behaviour
    /// would not be a release.
    static let isDevelopment: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
}
