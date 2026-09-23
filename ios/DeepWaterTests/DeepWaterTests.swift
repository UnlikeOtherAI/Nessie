import XCTest

@testable import DeepWater

@MainActor final class DeepWaterTests: XCTestCase {
    func testCallbackRequiresExactOriginPathAndState() throws {
        let valid = try XCTUnwrap(
            URL(string: "https://admin.deepwater.live/auth/callback?code=abc&state=expected"))
        XCTAssertEqual(try OAuthSignIn.validate(valid, state: "expected"), "abc")
        for invalid in [
            "https://evil.example/auth/callback?code=abc&state=expected",
            "https://admin.deepwater.live/other?code=abc&state=expected",
            "https://admin.deepwater.live/auth/callback?code=abc&state=wrong",
            "https://admin.deepwater.live/auth/callback?code=abc&state=expected&state=expected",
            "https://admin.deepwater.live/auth/callback?code=abc&code=def&state=expected",
            "https://admin.deepwater.live/auth/callback?code=abc&state=expected&error=access_denied"
        ] {
            let url = try XCTUnwrap(URL(string: invalid))
            XCTAssertThrowsError(try OAuthSignIn.validate(url, state: "expected"))
        }
    }

    func testDraftUsesHostedContractAndExplicitPrivacy() {
        var draft = ResearchDraft()
        draft.query = "  Jak města zvládají vedro?  "
        draft.pillars = ["Dopad na obyvatele", "Řešení"]
        XCTAssertEqual(draft.body["query"].text, "Jak města zvládají vedro?")
        XCTAssertEqual(draft.body["output_tier"].text, "full")
        XCTAssertEqual(draft.body["public"], .bool(false))
        XCTAssertEqual(draft.body["report_on_demand"], .bool(false))
        XCTAssertEqual(draft.body["pillars"].array.count, 2)
    }

    func testLaunchKeepsBodyAndKeyAcrossRetry() throws {
        let identity = try SessionIdentity(token: FixtureTransport.token)
        let launch = ResearchLaunch(
            identity: identity, body: .object(["query": .string("whats new in batteries?")]))
        let restored = try JSONDecoder().decode(ResearchLaunch.self, from: JSONEncoder().encode(launch))
        XCTAssertEqual(restored, launch)
        XCTAssertTrue(restored.belongs(to: identity))
        XCTAssertNotNil(UUID(uuidString: restored.key))
        XCTAssertEqual(restored.key, restored.key.lowercased())
    }

    func testAbsentCapabilitiesNeverEnableMutation() throws {
        let run = try ResearchRun(
            .object(["id": .string("a"), "query": .string("Research"), "status": .string("complete")]))
        XCTAssertTrue(run.capabilities.isEmpty)
        XCTAssertThrowsError(try ResearchRun(.object(["id": .string("a")])))
    }

    func testFullReportKeepsRefreshingAfterResearchCompletes() throws {
        var fields = FixtureTransport.runs[0].object
        fields["full_report_status"] = .string("compiling")
        let compiling = try ResearchRun(.object(fields))
        XCTAssertTrue(compiling.isActive)
        XCTAssertEqual(compiling.statusLabel, "Writing full report")
        fields["full_report_status"] = .string("complete")
        XCTAssertFalse(try ResearchRun(.object(fields)).isActive)
        fields["full_report_status"] = .string("failed")
        XCTAssertEqual(try ResearchRun(.object(fields)).statusLabel, "Summary available; full report failed")
    }

    func testMarkdownKeepsCodeParagraphsAndTablesIntact() {
        let markdown = "# Title\n\n## Findings\nText\n\n```swift\nlet a = 1\n\nlet b = 2\n```\n"
            + "\n| Option | Detail |\n| --- | :---: |\n| A | First |\n\nNext paragraph"
        XCTAssertEqual(ReportBlock.parse(markdown, title: "Title"), [
            .heading(2, "Findings"), .paragraph("Text"), .code("let a = 1\n\nlet b = 2"),
            .table([["Option", "Detail"], ["A", "First"]]), .paragraph("Next paragraph")
        ])
        XCTAssertEqual(ReportBlock.parse("# Other title", title: "Title"), [.heading(1, "Other title")])
        XCTAssertEqual(JSONValue.number(1e30).int, 0)
    }

    func testAssistantKeepsNonEnglishAndToolOnlyQuestions() {
        let assistant = ResearchAssistant()
        _ = assistant.consume(
            .object([
                "type": .string("pillars"),
                "data": .object([
                    "pillars": .strings(["Jak to funguje?", "ça marche comment ?"])
                ])
            ]))
        XCTAssertEqual(assistant.pillars.count, 2)
        _ = assistant.consume(.object(["type": .string("token"), "content": .string("Zjistím to.")]))
        XCTAssertEqual(assistant.messages.last?.text, "Zjistím to.")
        XCTAssertTrue(assistant.consume(.object(["type": .string("done")])))
    }

    func testChangedWorkspaceDropsPreviouslyLoadedViews() async throws {
        let api = DeepWaterAPI(testing: true)
        await api.restore()
        let previousGeneration = api.generation
        let claims = "{\"sub\":\"fixture-user\",\"active\":{\"orgId\":\"other-org\",\"teamId\":\"other-team\"}}"
        let payload = Data(claims.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        try api.accept(.object(["access_token": .string("fixture.\(payload).fixture")]))
        XCTAssertNotEqual(api.generation, previousGeneration)
        XCTAssertEqual(api.identity?.team, "other-team")
    }

    func testAPIUsesRealRouteAndScopeShapes() async throws {
        let api = DeepWaterAPI(testing: true)
        await api.restore()
        XCTAssertNotNil(api.identity)
        let list = try await api.request("/v1/admin/runs?limit=50&offset=0&order=activity")
        XCTAssertEqual(try list["runs"].array.map(ResearchRun.init).count, 2)
        let sources = try await api.request("/v1/research/11111111-1111-4111-8111-111111111111/sources")
        XCTAssertEqual(sources["sources"].array.count, 2)
        try await api.signOut()
        XCTAssertNil(api.identity)
    }
}
