import ExpoModulesCore
import ObjectiveC.runtime
import UIKit

/// The name of the notification the `UIWindow` handler posts when a registered
/// key command fires. The module listens for it and forwards to JS. A
/// notification (rather than a direct module reference) keeps the swizzled
/// `UIWindow` extension free of any dependency on the module instance.
private let nessieKeyCommandFiredNotification = Notification.Name("NessieKeyCommandFired")
private let nessieKeyCommandIdKey = "id"

/// Process-wide store of the commands JS asked us to register.
///
/// The registrar is deliberately ignorant of what a command *does*: it holds the
/// key, the modifier bitmask, the overlay title, and the id to echo back, and
/// nothing else. `UIWindow.keyCommands` reads this each time UIKit asks, so a
/// re-`register` from JS simply replaces the list.
private final class NessieKeyCommandRegistry {
    static let shared = NessieKeyCommandRegistry()

    private let lock = NSLock()
    private var stored: [UIKeyCommand] = []

    func replace(with commands: [UIKeyCommand]) {
        lock.lock()
        stored = commands
        lock.unlock()
    }

    var commands: [UIKeyCommand] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

extension UIWindow {
    /// Handles a fired command by posting its id. Implemented on `UIWindow`
    /// because the window is always in the responder chain above the WebView, so
    /// UIKit walks up to it for any chord the web content did not consume — the
    /// shortcuts work without the shell ever becoming first responder, leaving
    /// text entry in the WebView untouched.
    @objc func nessieHandleKeyCommand(_ sender: UIKeyCommand) {
        guard let id = sender.propertyList as? String else { return }
        NotificationCenter.default.post(
            name: nessieKeyCommandFiredNotification,
            object: nil,
            userInfo: [nessieKeyCommandIdKey: id]
        )
    }

    /// The replacement `keyCommands` getter installed by the swizzle: whatever
    /// the window already offered, plus ours. Because the original implementation
    /// is preserved and called, no system or RN key command is dropped.
    @objc func nessieKeyCommands() -> [UIKeyCommand]? {
        // Calls the original getter (implementations were exchanged).
        let inherited = self.nessieKeyCommands() ?? []
        return inherited + NessieKeyCommandRegistry.shared.commands
    }
}

private enum NessieKeyCommandSwizzle {
    static var installed = false

    /// Exchange `UIWindow.keyCommands` with our merging getter, once.
    static func installIfNeeded() {
        guard !installed else { return }
        installed = true
        guard
            let original = class_getInstanceMethod(UIWindow.self, #selector(getter: UIView.keyCommands)),
            let replacement = class_getInstanceMethod(UIWindow.self, #selector(UIWindow.nessieKeyCommands))
        else {
            installed = false
            return
        }
        method_exchangeImplementations(original, replacement)
    }
}

public class NessieKeyCommandsModule: Module {
    public func definition() -> ModuleDefinition {
        Name("NessieKeyCommands")

        Events("onKeyCommand")

        // Forward a fired command to JS. The observer is torn down with the
        // module, and events are only sent while a JS listener is attached.
        OnCreate {
            NotificationCenter.default.addObserver(
                forName: nessieKeyCommandFiredNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                guard let id = notification.userInfo?[nessieKeyCommandIdKey] as? String else { return }
                self?.sendEvent("onKeyCommand", ["id": id])
            }
        }

        OnDestroy {
            NotificationCenter.default.removeObserver(self)
        }

        Function("isSupported") { () -> Bool in
            UIDevice.current.userInterfaceIdiom == .pad
        }

        // Synchronous from JS; the UIKit work (installing the swizzle, replacing
        // the command list UIKit will read) is hopped to the main thread inside,
        // because a plain `Function` body runs on the JS thread and `UIWindow`
        // must only be touched on main.
        Function("register") { (commands: [[String: Any]]) in
            DispatchQueue.main.async {
                let built: [UIKeyCommand] = commands.compactMap { entry in
                    guard
                        let id = entry["id"] as? String,
                        let input = entry["input"] as? String,
                        let title = entry["title"] as? String
                    else { return nil }
                    // `modifierFlags` arrives as a JS number; accept whichever
                    // numeric type the bridge hands us.
                    let rawFlags = (entry["modifierFlags"] as? Int)
                        ?? (entry["modifierFlags"] as? Double).map(Int.init)
                        ?? 0
                    let command = UIKeyCommand(
                        title: title,
                        image: nil,
                        action: #selector(UIWindow.nessieHandleKeyCommand(_:)),
                        input: input,
                        modifierFlags: UIKeyModifierFlags(rawValue: rawFlags),
                        propertyList: id
                    )
                    // Fire even where UIKit has a default for the chord (e.g. ⌘R).
                    command.wantsPriorityOverSystemBehavior = true
                    return command
                }
                NessieKeyCommandRegistry.shared.replace(with: built)
                NessieKeyCommandSwizzle.installIfNeeded()
            }
        }
    }
}
