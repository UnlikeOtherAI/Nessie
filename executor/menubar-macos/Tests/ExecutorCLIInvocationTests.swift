import XCTest

final class ExecutorCLIInvocationTests: XCTestCase {
    private let stateDirectory = "/private/state"

    /// The property this whole file exists for: a pairing challenge and a
    /// workspace path never appear in `argv`, where every process on this Mac
    /// could read them. `--pair-input-stdin` is what makes that true.
    func testPairingKeepsSensitiveInputOffTheProcessList() throws {
        let invocation = try ExecutorCLI.pair(
            apiBaseUrl: "https://api.nessie.works",
            enrollmentId: "00000000-0000-4000-8000-000000000001",
            challenge: "secret-challenge",
            workspaceRoot: "/private/workspace",
            stateDirectory: stateDirectory
        )
        XCTAssertTrue(invocation.arguments.contains("--pair-input-stdin"))
        XCTAssertFalse(invocation.arguments.contains("secret-challenge"))
        XCTAssertFalse(invocation.arguments.contains("/private/workspace"))
        XCTAssertFalse(invocation.arguments.contains("--challenge"))
        XCTAssertFalse(invocation.arguments.contains("--workspace"))

        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        XCTAssertEqual(parsed["challenge"] as? String, "secret-challenge")
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

    /// The fingerprint is read out of the CLI's own success line. This app never
    /// sees the machine key, so it could not compute one if it wanted to.
    func testTheFingerprintIsReadFromThePairSuccessLine() {
        let output = "Pairing request submitted. Confirm fingerprint SHA256:abc123 in Nessie, "
            + "then run connect.\n"
        XCTAssertEqual(PairingOutput.fingerprint(in: output), "SHA256:abc123")
        XCTAssertNil(PairingOutput.fingerprint(in: "Executor daemon connection established.\n"))
    }
}
