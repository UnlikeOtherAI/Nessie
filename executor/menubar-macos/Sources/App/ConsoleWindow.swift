import AppKit
import WebKit

/// The same packaged document as Windows, with a process-local native bridge.
@MainActor
final class ConsoleWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private let connections: ExecutorConnections
    private var window: NSWindow?
    private var webView: WKWebView?
    private var bridge: ExecutorConsoleBridge?
    private var entryURL: URL?
    private var section: ConsoleSection = .settings
    private var teams = false
    private var pair = false

    init(connections: ExecutorConnections) { self.connections = connections }

    func showTeams(pair: Bool = false) {
        show(.settings)
        teams = true
        self.pair = pair
        selectSection()
    }

    func show(_ section: ConsoleSection) {
        self.section = section
        teams = false
        pair = false
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            selectSection()
            return
        }
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("executor-console") else { return }
        let entry = folder.appendingPathComponent("index.html")
        let bridge = ExecutorConsoleBridge(connections: connections, entryURL: entry)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "executor")
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 680), configuration: configuration)
        webView.navigationDelegate = self
        let window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        window.title = "Nessie Executor"
        window.minSize = NSSize(width: 440, height: 500)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        bridge.close = { [weak window] in window?.close() }
        self.bridge = bridge
        self.webView = webView
        self.window = window
        entryURL = entry
        webView.loadFileURL(entry, allowingReadAccessTo: folder)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func selectSection() {
        let event = teams ? (pair ? "tray://pair" : "tray://section/teams") : "tray://section/\(section.rawValue)"
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('\(event)'))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { selectSection() }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(navigationAction.request.url == entryURL ? .allow : .cancel)
    }

    func windowWillClose(_ notification: Notification) {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "executor")
        window = nil
        webView = nil
        bridge = nil
        connections.controllers.forEach { $0.pairing.restore() }
    }
}
