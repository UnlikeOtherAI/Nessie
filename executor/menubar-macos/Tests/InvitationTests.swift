import XCTest

/// The same cases as `executor/tray-windows/src-tauri/src/invitation.rs`, because
/// the two trays read the same paste off the same page and must not disagree
/// about what an invitation is.
final class InvitationTests: XCTestCase {
    private let enrollment = "3f1c9a2e-0000-4000-8000-000000000001"
    private let challenge = "Zm9vYmFyLWNoYWxsZW5nZQ"

    func testReadsThePairingCommandTheExecutorsPageOffers() throws {
        let command = "nessie-executor pair --api https://api.nessie.works --state-dir "
            + "\"$HOME/.nessie-executor\" --workspace \"/absolute/read-only/workspace\" "
            + "--enrollment \(enrollment) --challenge \(challenge)"
        let invitation = try InvitationParser.parse(command, isDevelopmentBuild: false).get()
        XCTAssertEqual(invitation.enrollmentId, enrollment)
        XCTAssertEqual(invitation.challenge, challenge)
        XCTAssertEqual(invitation.apiBaseUrl, "https://api.nessie.works")
    }

    func testReadsAnInvitationLinkWithTheSameTwoValues() throws {
        let invitation = try InvitationParser.parse(
            "https://app.nessie.works/agents/executors?enrollmentId=\(enrollment)&challenge=\(challenge)%3D",
            isDevelopmentBuild: false
        ).get()
        XCTAssertEqual(invitation.enrollmentId, enrollment)
        // Percent-encoded base64 padding survives: a challenge that lost its `=`
        // would be rejected by the API with nothing to explain it.
        XCTAssertEqual(invitation.challenge, "\(challenge)=")
        XCTAssertEqual(invitation.apiBaseUrl, ApprovedAPIOrigin.production)
    }

    func testAnInvitationWithNoApiFallsBackToThisBuildsOrigin() throws {
        let text = "pair --enrollment \(enrollment) --challenge \(challenge)"
        XCTAssertEqual(
            try InvitationParser.parse(text, isDevelopmentBuild: true).get().apiBaseUrl,
            ApprovedAPIOrigin.localDevelopment
        )
        XCTAssertEqual(
            try InvitationParser.parse(text, isDevelopmentBuild: false).get().apiBaseUrl,
            ApprovedAPIOrigin.production
        )
    }

    func testAcceptsTheEqualsFormAndQuotedValues() throws {
        let invitation = try InvitationParser.parse(
            "pair --enrollment=\(enrollment) --challenge=\"\(challenge)\"",
            isDevelopmentBuild: false
        ).get()
        XCTAssertEqual(invitation.enrollmentId, enrollment)
        XCTAssertEqual(invitation.challenge, challenge)
    }

    func testRefusesAnythingThatIsNotAnInvitation() {
        for text in [
            "",
            "   ",
            "hello",
            // Half an invitation is not one; pairing with a missing challenge
            // would fail at the API with nothing to explain it.
            "pair --enrollment \(enrollment)",
            "pair --challenge \(challenge)",
            // A flag whose value is the next flag has no value at all.
            "pair --enrollment --challenge \(challenge)",
        ] {
            XCTAssertNil(
                try? InvitationParser.parse(text, isDevelopmentBuild: false).get(),
                "text \(text.debugDescription) must be refused"
            )
        }
    }

    func testTheEmptyPasteNamesWhereToGetAnInvitation() {
        guard case let .failure(refusal) = InvitationParser.parse("  ", isDevelopmentBuild: false) else {
            return XCTFail("an empty paste must be refused")
        }
        XCTAssertEqual(refusal.message, "Paste the invitation from Agents → Executors in Nessie.")
    }
}
