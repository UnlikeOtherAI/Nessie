import ExpoModulesCore
import UIKit

/// Switches the Home Screen icon between the dark default and the light
/// alternative. The alternative is compiled into the asset catalog by
/// `plugins/with-light-app-icon.js`; `nil` is the primary (dark) icon.
public class NessieAppIconModule: Module {
    private static let lightIconName = "AppIconLight"

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
            return name == Self.lightIconName ? "light" : "dark"
        }

        AsyncFunction("setIcon") { (icon: String, promise: Promise) in
            let name: String? = icon == "light" ? Self.lightIconName : nil
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
