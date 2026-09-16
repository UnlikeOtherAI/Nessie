import AppKit
import Combine
import Foundation

/// Where this app keeps executor state. One Mac, one executor: the menu bar is a
/// personal surface, and a person who needs several executors on one machine is
/// the headless CLI's case, not this one.
enum ExecutorPaths {
    static let stateDirectoryOverrideVariable = "NESSIE_EXECUTOR_MENUBAR_STATE_DIR"

    static func stateDirectory(isDevelopmentBuild: Bool) -> String {
        // A development build may be pointed at an already-paired state directory
        // so the app can be driven against a local API. A release never reads
        // this: the state directory of a shipped app is not a thing an
        // environment variable gets to choose.
        if isDevelopmentBuild,
           let override = ProcessInfo.processInfo.environment[stateDirectoryOverrideVariable],
           !override.isEmpty {
            return (override as NSString).expandingTildeInPath
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support
            .appendingPathComponent("Nessie Executor")
            .appendingPathComponent("executor")
            .path
    }

    /// Owner-only, created before anything is written into it.
    static func prepare(_ directory: String) throws {
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }
}

@MainActor
final class ExecutorController: ObservableObject {
    @Published private(set) var model = MenuModel(pairing: .unpaired, daemon: .stopped)
    /// The last refusal a person has not yet dismissed, shown by whichever panel
    /// raised it. Never swallowed: a policy change that did not land has to say
    /// so in the CLI's own words.
    @Published var refusal: String?
    @Published private(set) var busy = false
    /// The fingerprint the most recent `pair` printed, held until the daemon
    /// starts, because confirming it in Nessie is the next thing a person does.
    @Published private(set) var pendingFingerprint: String?

    let isDevelopmentBuild: Bool
    let stateDirectory: String
    private let runtime: Result<PackagedRuntime, ExecutorRefusal>
    private let work = DispatchQueue(label: "works.nessie.executor.menubar.cli")
    private var daemon: (process: Process, parentLiveness: FileHandle)?
    private var refreshTimer: Timer?

    init(isDevelopmentBuild: Bool) {
        self.isDevelopmentBuild = isDevelopmentBuild
        self.stateDirectory = ExecutorPaths.stateDirectory(isDevelopmentBuild: isDevelopmentBuild)
        self.runtime = PackagedRuntime.locate(in: Bundle.main.resourceURL)
    }

    private var runner: ExecutorProcessRunner? {
        guard case let .success(runtime) = runtime else { return nil }
        return ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: isDevelopmentBuild)
    }

    var apiOrigin: String { ApprovedAPIOrigin.default(isDevelopmentBuild: isDevelopmentBuild) }

    // MARK: - Reading

    func start() {
        refresh()
        // The daemon's own lease and a child that exited on its own are both
        // facts this app has to notice without being clicked, so the icon can
        // never be showing something that stopped being true.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        guard let runner else {
            if case let .failure(refusal) = runtime {
                model = MenuModel(pairing: .unavailable(refusal.message), daemon: .stopped)
            }
            return
        }
        let stateDirectory = self.stateDirectory
        let invocation = ExecutorCLI.describe(stateDirectory: stateDirectory)
        work.async { [weak self] in
            let completion = try? runner.run(invocation)
            let description = completion.flatMap { completion -> ExecutorDescription? in
                guard completion.succeeded else { return nil }
                return try? ExecutorDescription.decode(Data(completion.standardOutput.utf8))
            }
            let lease = DaemonLeaseReader.read(in: stateDirectory)
            Task { @MainActor [weak self] in
                self?.apply(description: description, completion: completion, lease: lease)
            }
        }
    }

    private func apply(
        description: ExecutorDescription?,
        completion: ExecutorProcessRunner.Completion?,
        lease: DaemonLease
    ) {
        guard let description else {
            // A state directory that does not exist yet is not a failure; it is
            // the ordinary state of a Mac nobody has paired.
            let notPaired = !FileManager.default.fileExists(atPath: stateDirectory)
                || completion?.standardError.contains("ENOENT") == true
                || completion?.standardError.contains("executor-state.json") == true
            model = MenuModel(
                pairing: notPaired
                    ? .unpaired
                    : .unavailable(
                        completion.map {
                            ExecutorProcessRunner.refusal(from: $0, fallback: "nothing paired").message
                        } ?? "nothing paired"
                    ),
                daemon: .stopped
            )
            return
        }
        model = MenuModel(pairing: .paired(description), daemon: currentDaemonState(lease: lease))
    }

    private func currentDaemonState(lease: DaemonLease) -> DaemonState {
        if let daemon, daemon.process.isRunning { return .running }
        if daemon != nil {
            // The child exited on its own; stop holding a handle to it.
            self.daemon = nil
        }
        if leaseBlocksStart(lease, daemonIsLive: { kill($0, 0) == 0 }) { return .stopping }
        if pendingFingerprint != nil { return .awaitingConfirmation }
        return .stopped
    }

    // MARK: - Writing (always through the CLI)

    private func perform(
        _ invocation: ExecutorCLIInvocation,
        fallbackRefusal: String,
        onSuccess: @escaping @MainActor (String) -> Void
    ) {
        guard let runner else {
            refusal = PackagedRuntime.missingRefusal
            return
        }
        busy = true
        work.async { [weak self] in
            let result: Result<String, ExecutorRefusal>
            do {
                let completion = try runner.run(invocation)
                result = completion.succeeded
                    ? .success(completion.standardOutput)
                    : .failure(ExecutorProcessRunner.refusal(from: completion, fallback: fallbackRefusal))
            } catch {
                result = .failure(ExecutorRefusal(fallbackRefusal))
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                switch result {
                case let .success(output):
                    onSuccess(output)
                case let .failure(refusal):
                    self.refusal = refusal.message
                }
                self.refresh()
            }
        }
    }

    func pair(invitationText: String, workspaceRoot: String) {
        switch InvitationParser.parse(invitationText, isDevelopmentBuild: isDevelopmentBuild) {
        case let .failure(refusal):
            self.refusal = refusal.message
        case let .success(invitation):
            switch ApprovedAPIOrigin.approve(invitation.apiBaseUrl, isDevelopmentBuild: isDevelopmentBuild) {
            case let .failure(refusal):
                self.refusal = refusal.message
            case let .success(apiBaseUrl):
                do {
                    try ExecutorPaths.prepare(stateDirectory)
                    let invocation = try ExecutorCLI.pair(
                        apiBaseUrl: apiBaseUrl,
                        enrollmentId: invitation.enrollmentId,
                        challenge: invitation.challenge,
                        workspaceRoot: workspaceRoot,
                        stateDirectory: stateDirectory
                    )
                    perform(
                        invocation,
                        fallbackRefusal: "Nessie executor pairing was rejected. No pairing output was retained."
                    ) { [weak self] output in
                        self?.pendingFingerprint = PairingOutput.fingerprint(in: output)
                    }
                } catch {
                    refusal = "Nessie Executor could not prepare its private state directory."
                }
            }
        }
    }

    /// One local-policy proposal. Operations, workspace and permitted programs go
    /// together on every call because that is what the CLI reads; each panel
    /// re-states the two it is not editing exactly as `describe` reported them.
    func proposePolicy(
        operationKeys: [String]? = nil,
        workspaceRoot: String? = nil,
        commandAllowlist: [String]? = nil
    ) {
        guard let description = model.description else {
            refusal = "Pair this Mac with Nessie before changing its local policy."
            return
        }
        do {
            let invocation = try ExecutorCLI.configure(
                operationKeys: operationKeys ?? description.policy.operations,
                workspaceRoot: workspaceRoot ?? description.reach.workspaceRoot,
                commandAllowlist: commandAllowlist ?? description.policy.permittedPrograms,
                stateDirectory: stateDirectory
            )
            let wasRunning = model.daemon == .running
            if wasRunning { stopDaemon() }
            perform(
                invocation,
                fallbackRefusal: "The local executor policy was rejected. No command output was retained."
            ) { [weak self] _ in
                if wasRunning { self?.startDaemon() }
            }
        } catch {
            refusal = "Nessie Executor could not prepare the local policy input."
        }
    }

    // MARK: - Supervision

    func startDaemon() {
        guard let runner else {
            refusal = PackagedRuntime.missingRefusal
            return
        }
        guard model.description != nil else {
            refusal = "Pair this Mac with Nessie before starting its executor."
            return
        }
        if daemon?.process.isRunning == true { return }
        if leaseBlocksStart(DaemonLeaseReader.read(in: stateDirectory), daemonIsLive: { kill($0, 0) == 0 }) {
            refusal = "The prior local daemon is still tearing down. Wait for it to finish before starting again."
            return
        }
        let stateDirectory = self.stateDirectory
        busy = true
        work.async { [weak self] in
            // `connect` first, exactly as the desktop companion does: it is the
            // call that proves somebody confirmed this executor's fingerprint in
            // Nessie, and its refusal is the remedy a person needs.
            let connect = try? runner.run(ExecutorCLI.connect(stateDirectory: stateDirectory))
            guard let connect, connect.succeeded else {
                Task { @MainActor [weak self] in
                    self?.busy = false
                    self?.refusal = connect.map {
                        ExecutorProcessRunner.refusal(
                            from: $0,
                            fallback: "Confirm this executor's fingerprint in Nessie before starting its daemon."
                        ).message
                    } ?? "Confirm this executor's fingerprint in Nessie before starting its daemon."
                    self?.refresh()
                }
                return
            }
            let spawned = try? runner.spawnDaemon(stateDirectory: stateDirectory)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                guard let spawned else {
                    self.refusal = "Nessie Executor could not start the executor daemon."
                    return
                }
                self.daemon = spawned
                self.pendingFingerprint = nil
                self.refresh()
            }
        }
    }

    /// Asks the daemon to stop and waits. It is never killed: a daemon with
    /// guests still tearing down is waited for and then refused, so a sandbox is
    /// never abandoned half-torn-down.
    @discardableResult
    func stopDaemon() -> Bool {
        guard let daemon else { return true }
        if !daemon.process.isRunning {
            self.daemon = nil
            refresh()
            return true
        }
        kill(daemon.process.processIdentifier, SIGTERM)
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if !daemon.process.isRunning {
                self.daemon = nil
                refresh()
                return true
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        refusal = "The executor is still stopping. Nessie Executor will not force-kill a sandbox daemon."
        refresh()
        return false
    }

    /// Quitting stops the daemon. Closing the parent-liveness pipe would do it on
    /// its own, but the app waits for the teardown rather than exiting while
    /// guests are still running.
    func shutdown() {
        guard daemon != nil else { return }
        _ = stopDaemon()
        daemon?.parentLiveness.closeFile()
        daemon = nil
    }
}
