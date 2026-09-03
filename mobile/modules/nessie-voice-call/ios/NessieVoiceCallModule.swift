import ExpoModulesCore

/// The JS boundary.
///
/// Everything with a lifecycle lives behind `VoiceCallController`, which the
/// process owns; this class is only a view of it that comes and goes with each
/// JS bundle. That split is the whole reason a call survives a reload.
public class NessieVoiceCallModule: Module {
    public func definition() -> ModuleDefinition {
        Name("NessieVoiceCall")

        Events("onCallState")

        OnStartObserving {
            Task { @MainActor [weak self] in
                VoiceCallController.shared.onSnapshot = { [weak self] snapshot in
                    self?.sendEvent("onCallState", ["state": snapshot.dictionary])
                }
            }
        }

        OnStopObserving {
            Task { @MainActor in
                VoiceCallController.shared.onSnapshot = nil
            }
        }

        AsyncFunction("startCall") { (provisioning: [String: Any]) in
            try await VoiceCallController.shared.start(provisioning: provisioning)
        }

        AsyncFunction("endCall") {
            await VoiceCallController.shared.end()
        }

        AsyncFunction("setMuted") { (muted: Bool) in
            await VoiceCallController.shared.setMuted(muted)
        }

        /// Asked on mount, because a JS reload survives the call but not the
        /// event stream. Synchronous, and off the main actor by design: the
        /// shell needs an answer before its first paint, and the queue it would
        /// otherwise wait on is the one doing the painting.
        Function("getActiveCallState") { () -> [String: Any] in
            VoiceCallController.currentSnapshot
        }
    }
}
