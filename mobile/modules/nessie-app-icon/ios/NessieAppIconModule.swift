import ExpoModulesCore
import UIKit

/// Switches the Home Screen icon between the light default and the dark
/// alternative. The alternative is compiled into the asset catalog by
/// `plugins/with-dark-app-icon.js`; `nil` is the primary (light) icon.
public class NessieAppIconModule: Module {
    private static let darkIconName = "AppIconDark"

    public func definition() -> ModuleDefinition {
        Name("NessieAppIcon")

        Function("isSupported") { () -> Bool in
            Thread.isMainThread
                ? UIApplication.shared.supportsAlternateIcons
                : DispatchQueue.main.sync { UIApplication.shared.supportsAlternateIcons }
        }

        Function("getIcon") { () -> String in
            let name = Thread.isMainThread
                ? UIApplication.shared.alternateIconName
                : DispatchQueue.main.sync { UIApplication.shared.alternateIconName }
            return name == Self.darkIconName ? "dark" : "light"
        }

        AsyncFunction("setIcon") { (icon: String, promise: Promise) in
            let name: String? = icon == "dark" ? Self.darkIconName : nil
            guard UIApplication.shared.alternateIconName != name else {
                promise.resolve(icon)
                return
            }
            UIApplication.shared.setAlternateIconName(name) { error in
                if let error {
                    promise.reject("ERR_APP_ICON", error.localizedDescription)
                } else {
                    promise.resolve(icon)
                }
            }
        }.runOnQueue(.main)
    }
}
