import AppKit
import WebKit

@MainActor
final class ExecutorConsoleBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let connections: ExecutorConnections
    private let entryURL: URL
    var close: (() -> Void)?

    init(connections: ExecutorConnections, entryURL: URL) {
        self.connections = connections
        self.entryURL = entryURL
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url == entryURL,
              let body = message.body as? [String: Any], let command = body["command"] as? String else {
            replyHandler(nil, "Only the local executor window can change this computer's settings.")
            return
        }
        Task {
            do { replyHandler(try await invoke(command, args: body["args"] as? [String: Any] ?? [:]), nil) }
            catch let refusal as ExecutorRefusal { replyHandler(nil, refusal.message) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    private func selected(_ args: [String: Any]) throws -> ExecutorController {
        guard let identifier = args["executorId"] as? String else { return connections.selected }
        guard let controller = connections.controllers.first(where: {
            $0.model.description?.executorId == identifier
        }) else { throw ExecutorRefusal("This team is not paired on this computer.") }
        return controller
    }

    private func text(_ args: [String: Any], _ key: String) throws -> String {
        guard let value = args[key] as? String, !value.isEmpty else { throw ExecutorRefusal("Missing \(key).") }
        return value
    }

    private func run(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Data {
        let runtime = try PackagedRuntime.locate(in: Bundle.main.resourceURL).get()
        let runner = ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: controller.isDevelopmentBuild)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let completed = try runner.run(invocation)
                    guard completed.succeeded else {
                        throw ExecutorProcessRunner.refusal(
                            from: completed, fallback: "The local executor refused this change."
                        )
                    }
                    continuation.resume(returning: Data(completed.standardOutput.utf8))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func json(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Any {
        try JSONSerialization.jsonObject(with: await run(invocation, controller: controller))
    }

    private func view() -> [String: Any] {
        ["kind": "reachable", "executors": connections.controllers.compactMap { controller -> [String: String]? in
            guard let description = controller.model.description else { return nil }
            return ["executorId": description.executorId, "daemonStatus": controller.model.daemon.rawValue]
        }]
    }

    private func configure(_ args: [String: Any], controller: ExecutorController) async throws -> Any {
        guard let input = args["configurationInput"] as? [String: Any] else {
            throw ExecutorRefusal("Missing local configuration.")
        }
        let wasRunning = controller.model.daemon == .running
        guard controller.stopDaemon() else { throw ExecutorRefusal("Wait for this executor to stop.") }
        defer { controller.refresh(startWhenPaired: wasRunning) }
        let invocation = ExecutorCLIInvocation(
            arguments: ["configure", "--configuration-input-stdin", "--state-dir", controller.stateDirectory],
            standardInput: try JSONSerialization.data(withJSONObject: input)
        )
        _ = try await run(invocation, controller: controller)
        return try await json(ExecutorCLI.describe(stateDirectory: controller.stateDirectory), controller: controller)
    }

    private func pairing(_ command: String, args: [String: Any]) async throws -> Any {
        if command == "executor_pairing_start" { connections.add() }
        if args["executorId"] == nil, let pending = connections.controllers.first(where: {
            ExecutorStateDiscovery.pendingAttemptBlocksStart(in: $0.stateDirectory)
        }) { connections.selectedDirectory = pending.stateDirectory }
        let controller = try selected(args)
        controller.pairing.shutdown()
        let directory = controller.stateDirectory
        let invocation: ExecutorCLIInvocation
        switch command {
        case "executor_pairing_start":
            let origin = try ApprovedAPIOrigin.approve(
                text(args, "apiBaseUrl"), isDevelopmentBuild: controller.isDevelopmentBuild
            ).get()
            try ExecutorPaths.prepare(directory)
            invocation = try ExecutorCLI.pairingStart(
                apiBaseUrl: origin, workspaceRoot: text(args, "workspaceRoot"),
                replace: false, stateDirectory: directory
            )
        case "executor_pairing_confirm":
            invocation = ExecutorCLI.pairingConfirm(
                stateDirectory: directory, claimDigest: try text(args, "claimDigest")
            )
        case "executor_pairing_cancel": invocation = ExecutorCLI.pairingCancel(stateDirectory: directory)
        default: invocation = ExecutorCLI.pairingStatus(stateDirectory: directory)
        }
        let result = try await json(invocation, controller: controller)
        let paired = (result as? [String: Any])?["status"] as? String == "paired"
        controller.refresh(startWhenPaired: command == "executor_pairing_confirm" && paired)
        return result
    }

    private func invoke(_ command: String, args: [String: Any]) async throws -> Any {
        if command.hasPrefix("executor_pairing_") { return try await pairing(command, args: args) }
        let controller = try selected(args)
        switch command {
        case "executor_view": return view()
        case "executor_describe":
            return try await json(ExecutorCLI.describe(stateDirectory: controller.stateDirectory), controller: controller)
        case "executor_configure": return try await configure(args, controller: controller)
        case "executor_start": controller.startDaemon(); return view()
        case "executor_stop":
            guard controller.stopDaemon() else { throw ExecutorRefusal("This executor is still stopping.") }
            return view()
        case "executor_choose_folder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            if panel.runModal() == .OK, let path = panel.url?.path { return path }
            return NSNull()
        case "executor_copy_code":
            let code = try text(args, "code")
            guard code.utf8.count == 8, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
                throw ExecutorRefusal("Invalid pairing code.")
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(code, forType: .string)
        case "executor_autostart":
            return ["enabled": LaunchAtLogin.isEnabled,
                    "note": "Paired connections start when this app opens. Quitting the app stops them."]
        case "executor_set_autostart":
            guard let enabled = args["enabled"] as? Bool else { throw ExecutorRefusal("Choose a login setting.") }
            if let refusal = LaunchAtLogin.set(enabled) { throw refusal }
        case "executor_open_nessie":
            NSWorkspace.shared.open(ApprovedAPIOrigin.consoleURL(
                forAPIOrigin: try text(args, "apiBaseUrl"), isDevelopmentBuild: controller.isDevelopmentBuild
            ))
        case "executor_hide_status": close?()
        default: throw ExecutorRefusal("Unknown local executor action.")
        }
        return NSNull()
    }
}
