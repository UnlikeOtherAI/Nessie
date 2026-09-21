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
        // Named after the product, never derived from the bundle identifier: an
        // identifier is a packaging decision and changing one must not strand a
        // person's pairing in a folder the new build never looks in.
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support
            .appendingPathComponent("Nessie Executor")
            .appendingPathComponent("executor")
            .path
    }

    static func discover(isDevelopmentBuild: Bool) -> Result<String, ExecutorRefusal> {
        let preferred = stateDirectory(isDevelopmentBuild: isDevelopmentBuild)
        if isDevelopmentBuild,
           ProcessInfo.processInfo.environment[stateDirectoryOverrideVariable]?.isEmpty == false {
            return .success(preferred)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ExecutorStateDiscovery.resolve(preferredDirectory: preferred, legacyRoots: [
            support.appendingPathComponent("com.unlikeotherai.nessie.desktop/executors").path,
            support.appendingPathComponent("com.unlikeotherai.nessie.executor.menubar/executors").path,
            (NSHomeDirectory() as NSString).appendingPathComponent(".local/state/nessie-executor")
        ])
    }

    /// The file `pair` writes. Its presence is the difference between "nobody
    /// has paired this Mac" and "something is wrong with a pairing that exists",
    /// and those two need different words. The file is never opened here.
    static func hasPairingFile(_ directory: String) -> Bool {
        FileManager.default.fileExists(
            atPath: (directory as NSString).appendingPathComponent("executor-state.json")
        )
    }

    static func refusalBeforePairing(in directory: String, isDevelopmentBuild: Bool) -> ExecutorRefusal? {
        switch discover(isDevelopmentBuild: isDevelopmentBuild) {
        case let .success(discovered) where discovered == directory:
            return nil
        case .success:
            return ExecutorRefusal(
                "This Mac gained another connection. Reopen Nessie Executor to review it before pairing again."
            )
        case let .failure(refusal):
            return refusal
        }
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
    /// The last failure a person has not yet dismissed, translated into what it
    /// means and what they can do about it. Never swallowed, and never shown as
    /// the API's own sentence alone — see `ExecutorFailure`.
    @Published var failure: ExecutorFailure?
    @Published private(set) var busy = false
    let pairing: ExecutorPairingController

    let isDevelopmentBuild: Bool
    let stateDirectory: String
    private let runtime: Result<PackagedRuntime, ExecutorRefusal>
    private let work = DispatchQueue(label: "com.unlikeotherai.nessie.executor.menubar.cli")
    private var daemon: (process: Process, parentLiveness: FileHandle)?
    private var refreshTimer: Timer?
    private var startAfterRefresh = false

    init(isDevelopmentBuild: Bool) {
        self.isDevelopmentBuild = isDevelopmentBuild
        let discovery = ExecutorPaths.discover(isDevelopmentBuild: isDevelopmentBuild)
        self.stateDirectory = (try? discovery.get())
            ?? ExecutorPaths.stateDirectory(isDevelopmentBuild: isDevelopmentBuild)
        self.runtime = discovery.flatMap { _ in PackagedRuntime.locate(in: Bundle.main.resourceURL) }
        let runtime = try? self.runtime.get()
        self.pairing = ExecutorPairingController(
            runner: runtime.map { ExecutorProcessRunner(runtime: $0, isDevelopmentBuild: isDevelopmentBuild) },
            stateDirectory: stateDirectory,
            isDevelopmentBuild: isDevelopmentBuild
        )
        pairing.onPaired = { [weak self] in self?.refresh(startWhenPaired: true) }
        pairing.onChanged = { [weak self] in self?.refresh() }
        pairing.beforeStart = { [weak self] in
            guard let self else { return false }
            guard let refusal = ExecutorPaths.refusalBeforePairing(
                in: self.stateDirectory, isDevelopmentBuild: self.isDevelopmentBuild
            ) else { return true }
            self.fail(refusal.message)
            return false
        }
        pairing.beforeReplace = { [weak self] in
            guard let self, self.model.daemon != .stopping else { return false }
            return self.stopDaemon()
        }
    }

    private var runner: ExecutorProcessRunner? {
        guard case let .success(runtime) = runtime else { return nil }
        return ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: isDevelopmentBuild)
    }

    /// Where the pairing panel's choice starts. A person changes it there; this
    /// is never what authorizes an origin — `ApprovedAPIOrigin.approve` is.
    var defaultAPIOrigin: String { ApprovedAPIOrigin.default(isDevelopmentBuild: isDevelopmentBuild) }

    // MARK: - Reading

    func start() {
        pairing.restore()
        refresh(startWhenPaired: true)
        // The daemon's own lease and a child that exited on its own are both
        // facts this app has to notice without being clicked, so the icon can
        // never be showing something that stopped being true.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh(startWhenPaired: Bool = false) {
        if startWhenPaired { startAfterRefresh = true }
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
                self?.startIfRequested()
            }
        }
    }

    private func startIfRequested() {
        guard startAfterRefresh, model.description != nil, model.daemon == .stopped,
              !busy, !pairingBlocksStart else { return }
        startAfterRefresh = false
        startDaemon()
    }

    private func apply(
        description: ExecutorDescription?,
        completion: ExecutorProcessRunner.Completion?,
        lease: DaemonLease
    ) {
        guard let description else {
            // No pairing file is the ordinary state of a Mac nobody has paired,
            // not a failure. Only its *presence* is checked — never its contents:
            // the moment this app read that file it would become a second
            // interpretation of the policy the daemon enforces.
            model = MenuModel(
                pairing: ExecutorPaths.hasPairingFile(stateDirectory)
                    ? .unavailable(
                        completion.map {
                            ExecutorProcessRunner.refusal(
                                from: $0,
                                fallback: "this executor's local state could not be read"
                            ).message
                        } ?? "the packaged executor runtime could not be run"
                    )
                    : .unpaired,
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
        return .stopped
    }

    // MARK: - Writing (always through the CLI)

    private func perform(
        _ invocation: ExecutorCLIInvocation,
        fallbackRefusal: String,
        onSuccess: @escaping @MainActor (String) -> Void
    ) {
        guard let runner else {
            fail(PackagedRuntime.missingRefusal)
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
                    self.fail(refusal.message)
                }
                self.refresh()
            }
        }
    }

    /// One local-policy proposal. Operations, workspace and permitted programs go
    /// together on every call because that is what the CLI reads; each panel
    /// re-states the two it is not editing exactly as `describe` reported them.
    func proposePolicy(
        operationKeys: [String]? = nil,
        workspaceFolders: [ExecutorDescription.Folder]? = nil,
        commandAllowlist: [String]? = nil
    ) {
        guard let description = model.description else {
            fail("Pair this Mac with Nessie before changing its local policy.")
            return
        }
        do {
            let invocation = try ExecutorCLI.configure(
                operationKeys: operationKeys ?? description.policy.operations,
                workspaceFolders: workspaceFolders ?? description.reach.folders,
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
            fail("Nessie Executor could not prepare the local policy input.")
        }
    }

    /// Every failure reaches a person through here, so there is one place that
    /// decides what a refusal means and exactly one banner shape it can take.
    func fail(_ message: String) {
        failure = ExecutorFailureTranslator.translate(message)
    }

    /// The remedy a banner offers, performed.
    func apply(_ remedy: ExecutorFailure.Remedy) {
        failure = nil
        switch remedy {
        case .none:
            return
        case .openNessie:
            NSWorkspace.shared.open(nessieExecutorsURL)
        case .restartExecutor:
            if stopDaemon() { startDaemon() }
        case .reProposePolicy:
            reProposePolicy()
        }
    }

    /// "Open Nessie" has to open the Nessie this Mac is paired with. A Mac
    /// paired with DeepTest or with somebody's own server that was sent to
    /// nessie.works would be a remedy pointing at a stranger's console.
    var nessieExecutorsURL: URL {
        ApprovedAPIOrigin.consoleURL(
            forAPIOrigin: pairing.state?.apiBaseUrl ?? model.description?.apiBaseUrl ?? defaultAPIOrigin,
            isDevelopmentBuild: isDevelopmentBuild
        )
    }

    /// Offers the settings this Mac already has as a *newer* revision, until
    /// Nessie stops calling them a rollback.
    ///
    /// Nessie refuses a revision lower than the highest it has recorded, and its
    /// refusal does not say which number that is — so the only way back is to
    /// propose the next one and ask again. Nothing about what the executor may
    /// do changes: each proposal restates the operations, workspace and
    /// permitted commands `describe` just reported, and every one of them still
    /// lands as a revision a person reviews in Nessie.
    private func reProposePolicy() {
        guard let runner, let description = model.description else {
            fail("Pair this Mac with Nessie before changing its local policy.")
            return
        }
        let proposal = ExecutorPolicyReproposal(
            runner: runner, description: description, stateDirectory: stateDirectory
        )
        let wasRunning = model.daemon == .running
        if wasRunning { _ = stopDaemon() }
        busy = true
        work.async { [weak self] in
            let result = proposal.run()
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                switch result {
                case .success:
                    self.failure = nil
                    if wasRunning { self.startDaemon() } else { self.refresh() }
                case let .failure(refusal):
                    self.fail(refusal.message)
                    self.refresh()
                }
            }
        }
    }

    // MARK: - Supervision

    private var pairingBlocksStart: Bool {
        pairing.busy || pairing.state?.isAttemptOpen == true
            || ExecutorStateDiscovery.pendingAttemptBlocksStart(in: stateDirectory)
    }

    func startDaemon() {
        guard !busy, !pairingBlocksStart else { return }
        guard let runner else {
            fail(PackagedRuntime.missingRefusal)
            return
        }
        guard model.description != nil else {
            fail("Pair this Mac with Nessie before starting its executor.")
            return
        }
        if daemon?.process.isRunning == true { return }
        if leaseBlocksStart(DaemonLeaseReader.read(in: stateDirectory), daemonIsLive: { kill($0, 0) == 0 }) {
            fail("The prior local daemon is still tearing down. Wait for it to finish before starting again.")
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
                    self?.fail(connect.map {
                        ExecutorProcessRunner.refusal(
                            from: $0,
                            fallback: "Confirm this executor's fingerprint in Nessie before starting its daemon."
                        ).message
                    } ?? "Confirm this executor's fingerprint in Nessie before starting its daemon.")
                    self?.refresh()
                }
                return
            }
            let spawned = try? runner.spawnDaemon(stateDirectory: stateDirectory)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                guard let spawned else {
                    self.fail("Nessie Executor could not start the executor daemon.")
                    return
                }
                self.daemon = spawned
                self.refresh()
            }
        }
    }

    /// Asks the daemon to stop and waits. It is never killed: a daemon with
    /// guests still tearing down is waited for and then refused, so a sandbox is
    /// never abandoned half-torn-down.
    @discardableResult
    func stopDaemon() -> Bool {
        startAfterRefresh = false
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
        fail("The executor is still stopping. Nessie Executor will not force-kill a sandbox daemon.")
        refresh()
        return false
    }

    /// Quitting stops the daemon. Closing the parent-liveness pipe would do it on
    /// its own, but the app waits for the teardown rather than exiting while
    /// guests are still running.
    func shutdown() {
        pairing.shutdown()
        guard daemon != nil else { return }
        _ = stopDaemon()
        daemon?.parentLiveness.closeFile()
        daemon = nil
    }
}
