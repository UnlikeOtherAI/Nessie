import AppKit

/// A hand-rolled `main` rather than a SwiftUI `App`: this app has no window at
/// launch and no Dock presence, so it sets the accessory activation policy
/// before anything else exists, and the delegate is held here because
/// `NSApplication.delegate` does not retain it.
@main
enum NessieExecutorMenuBarApp {
    @MainActor private static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        Self.delegate = delegate
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
