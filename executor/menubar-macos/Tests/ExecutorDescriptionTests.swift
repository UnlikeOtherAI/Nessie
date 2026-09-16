import XCTest

final class ExecutorDescriptionTests: XCTestCase {
    /// Decoding the CLI's own bytes is the proof the panels render what `describe`
    /// answers rather than a shape this app invented.
    func testDecodesWhatDescribePrinted() throws {
        let description = try ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
        XCTAssertEqual(description.apiBaseUrl, "http://127.0.0.1:5454")
        XCTAssertEqual(description.executorId, "32b7de69-e303-46d6-b864-8a99a80d25e6")
        XCTAssertEqual(description.policy.revision, 3)
        XCTAssertEqual(description.policy.permittedPrograms, ["git *", "node", "npm run *"])
        XCTAssertEqual(description.policy.limits.maxSessions, 1)
        XCTAssertEqual(description.reach.workspaceRoot, "/Users/dictator/.nessie-executor-dev/workspace")
        XCTAssertTrue(description.reach.allowedOrigins.isEmpty)
        XCTAssertFalse(description.sandbox.browserConfigured)
        XCTAssertEqual(description.workspaceLabel, "workspace")
    }

    /// `describe` deliberately never carries the machine key. Nothing in this
    /// type could hold one, and this states that as a test so a future field
    /// cannot quietly add one.
    func testTheDescriptionHasNowhereToPutACredential() throws {
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(describeFixtureJSON.utf8)) as? [String: Any]
        )
        XCTAssertEqual(Set(parsed.keys), ["apiBaseUrl", "executorId", "policy", "reach", "sandbox"])
    }

    func testCommandRunIsReadFromTheOperationList() throws {
        let withoutCommand = try ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
        XCTAssertFalse(withoutCommand.commandRunEnabled)

        let withCommand = describeFixtureJSON.replacingOccurrences(
            of: "\"sandbox.stop\"",
            with: "\"sandbox.stop\",\n      \"command.run\""
        )
        XCTAssertTrue(try ExecutorDescription.decode(Data(withCommand.utf8)).commandRunEnabled)
    }

    /// A workspace at the filesystem root has no folder name to show, so the
    /// label falls back to the path rather than rendering empty.
    func testAWorkspaceWithNoFolderNameStillHasALabel() throws {
        let atRoot = describeFixtureJSON.replacingOccurrences(
            of: "/Users/dictator/.nessie-executor-dev/workspace",
            with: "/"
        )
        XCTAssertEqual(try ExecutorDescription.decode(Data(atRoot.utf8)).workspaceLabel, "/")
    }
}
