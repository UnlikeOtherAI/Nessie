import XCTest

final class ExecutorCLIInvocationTests: XCTestCase {
    private let stateDirectory = "/private/state"

    /// The runtime owns the keys. The app sends a workspace and explicit replace
    /// choice through stdin, and never handles an invitation credential.
    func testPairingKeepsSensitiveInputOffTheProcessList() throws {
        let invocation = try ExecutorCLI.pairingStart(
            apiBaseUrl: "https://api.nessie.works",
            workspaceRoot: "/private/workspace",
            replace: true,
            stateDirectory: stateDirectory
        )
        XCTAssertEqual(invocation.arguments.first, "pairing-start")
        XCTAssertTrue(invocation.arguments.contains("--pairing-input-stdin"))
        XCTAssertTrue(invocation.arguments.contains("--json"))
        XCTAssertFalse(invocation.arguments.contains("/private/workspace"))
        XCTAssertFalse(invocation.arguments.contains("--challenge"))
        XCTAssertFalse(invocation.arguments.contains("--workspace"))

        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        XCTAssertEqual(parsed["replace"] as? Bool, true)
        XCTAssertEqual(parsed["workspaceRoot"] as? String, "/private/workspace")
    }

    /// The configure call states all three parts of the local policy, because the
    /// CLI reads all three: a panel that sent only the part it was editing would
    /// be asking the CLI to guess at the rest.
    func testConfigureStatesTheWholeLocalPolicyOnStandardInput() throws {
        let invocation = try ExecutorCLI.configure(
            operationKeys: ["file.read", "sandbox.stop"],
            workspaceFolders: [
                ExecutorDescription.Folder(name: "nessie", path: "/private/workspace"),
                ExecutorDescription.Folder(name: "notes", path: "/private/notes"),
            ],
            commandAllowlist: ["git", "node"],
            stateDirectory: stateDirectory
        )
        XCTAssertEqual(
            invocation.arguments,
            ["configure", "--configuration-input-stdin", "--state-dir", stateDirectory]
        )
        XCTAssertFalse(invocation.arguments.contains("--tools"))
        XCTAssertFalse(invocation.arguments.contains("--operations"))
        XCTAssertFalse(invocation.arguments.contains("--folder"))

        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(parsed["operationKeys"] as? [String], ["file.read", "sandbox.stop"])
        XCTAssertEqual(parsed["commandAllowlist"] as? [String], ["git", "node"])
        // The named form, never `workspaceRoot`: the single spelling derives a
        // name from the directory, which would rename a person's folder every
        // time this app re-stated a policy it was not editing.
        XCTAssertNil(parsed["workspaceRoot"])
        let folders = try XCTUnwrap(parsed["workspaceFolders"] as? [[String: String]])
        XCTAssertEqual(folders, [
            ["name": "nessie", "path": "/private/workspace"],
            ["name": "notes", "path": "/private/notes"],
        ])
    }

    /// An emptied list has to be sent as `[]` rather than omitted: an absent
    /// `commandAllowlist` is the CLI's instruction to *keep* the programs the
    /// policy already names.
    func testAnEmptiedAllowlistIsSentExplicitly() throws {
        let invocation = try ExecutorCLI.configure(
            operationKeys: ["file.read"],
            workspaceFolders: [ExecutorDescription.Folder(name: "nessie", path: "/private/workspace")],
            commandAllowlist: [],
            stateDirectory: stateDirectory
        )
        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(parsed["commandAllowlist"] as? [String], [])
    }

    /// The daemon is spawned with the pipe that makes supervision real. Without
    /// `--parent-liveness-stdin` the daemon would outlive the app that started it.
    func testServeHoldsTheParentLivenessPipe() {
        let invocation = ExecutorCLI.serve(stateDirectory: stateDirectory)
        XCTAssertEqual(
            invocation.arguments,
            ["serve", "--parent-liveness-stdin", "--state-dir", stateDirectory]
        )
        XCTAssertNil(invocation.standardInput)
    }

    func testDescribeAndConnectAreReadsWithNoInput() {
        XCTAssertEqual(
            ExecutorCLI.describe(stateDirectory: stateDirectory).arguments,
            ["describe", "--state-dir", stateDirectory]
        )
        XCTAssertNil(ExecutorCLI.describe(stateDirectory: stateDirectory).standardInput)
        XCTAssertEqual(
            ExecutorCLI.connect(stateDirectory: stateDirectory).arguments,
            ["connect", "--state-dir", stateDirectory]
        )
    }

    func testConfirmationPinsTheClaimThePersonSaw() {
        XCTAssertEqual(
            ExecutorCLI.pairingConfirm(stateDirectory: stateDirectory, claimDigest: "reviewed-claim").arguments,
            ["pairing-confirm", "--json", "--state-dir", stateDirectory, "--claim-digest", "reviewed-claim"]
        )
        XCTAssertEqual(
            ExecutorCLI.pairingStatus(stateDirectory: stateDirectory).arguments,
            ["pairing-status", "--json", "--state-dir", stateDirectory]
        )
        XCTAssertEqual(
            ExecutorCLI.pairingCancel(stateDirectory: stateDirectory).arguments,
            ["pairing-cancel", "--json", "--state-dir", stateDirectory]
        )
    }
}
