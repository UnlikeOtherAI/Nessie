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
        let invitation = try InvitationParser.parse(command, defaultApiBaseUrl: "https://api.nessie.works").get()
        XCTAssertEqual(invitation.enrollmentId, enrollment)
        XCTAssertEqual(invitation.challenge, challenge)
        XCTAssertEqual(invitation.apiBaseUrl, "https://api.nessie.works")
    }

    func testReadsAnInvitationLinkWithTheSameTwoValues() throws {
        let invitation = try InvitationParser.parse(
            "https://app.nessie.works/agents/executors?enrollmentId=\(enrollment)&challenge=\(challenge)%3D",
            defaultApiBaseUrl: "https://api.nessie.works"
        ).get()
        XCTAssertEqual(invitation.enrollmentId, enrollment)
        // Percent-encoded base64 padding survives: a challenge that lost its `=`
        // would be rejected by the API with nothing to explain it.
        XCTAssertEqual(invitation.challenge, "\(challenge)=")
        XCTAssertEqual(invitation.apiBaseUrl, "https://api.nessie.works")
    }

    func testAnInvitationWithNoApiFallsBackToTheChosenNessie() throws {
        let text = "pair --enrollment \(enrollment) --challenge \(challenge)"
        XCTAssertEqual(
            try InvitationParser.parse(text, defaultApiBaseUrl: "https://nessie.example.com").get().apiBaseUrl,
            "https://nessie.example.com"
        )
        XCTAssertEqual(
            try InvitationParser.parse(text, defaultApiBaseUrl: ApprovedAPIOrigin.localDevelopment)
                .get().apiBaseUrl,
            ApprovedAPIOrigin.localDevelopment
        )
    }

    /// An invitation that names its own Nessie is pairing with that one, and the
    /// panel reads it out of the paste while a person is still looking at it —
    /// the host is on screen before the button is pressed, not after.
    func testTheOriginInAPasteIsReadableOnItsOwn() {
        XCTAssertEqual(
            InvitationParser.apiBaseUrl(
                in: "nessie-executor pair --api https://nessie.example.com --enrollment \(enrollment)"
            ),
            "https://nessie.example.com"
        )
        XCTAssertEqual(
            InvitationParser.apiBaseUrl(
                in: "https://app.nessie.works/agents/executors?api=https%3A%2F%2Fapi.deeptest.live"
                    + "&enrollmentId=\(enrollment)"
            ),
            "https://api.deeptest.live"
        )
        XCTAssertNil(InvitationParser.apiBaseUrl(in: "pair --enrollment \(enrollment)"))
        XCTAssertNil(InvitationParser.apiBaseUrl(in: "   "))
    }

    func testAcceptsTheEqualsFormAndQuotedValues() throws {
        let invitation = try InvitationParser.parse(
            "pair --enrollment=\(enrollment) --challenge=\"\(challenge)\"",
            defaultApiBaseUrl: "https://api.nessie.works"
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
                try? InvitationParser.parse(text, defaultApiBaseUrl: "https://api.nessie.works").get(),
                "text \(text.debugDescription) must be refused"
            )
        }
    }

    func testTheEmptyPasteNamesWhereToGetAnInvitation() {
        guard case let .failure(refusal) = InvitationParser.parse("  ", defaultApiBaseUrl: "https://api.nessie.works") else {
            return XCTFail("an empty paste must be refused")
        }
        XCTAssertEqual(refusal.message, "Paste the invitation from Agents → Executors in Nessie.")
    }
}
