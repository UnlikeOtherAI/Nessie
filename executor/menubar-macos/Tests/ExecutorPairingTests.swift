import XCTest

final class ExecutorPairingTests: XCTestCase {
    private func decode(_ value: [String: Any]) throws -> ExecutorPairing {
        try ExecutorPairing.decode(JSONSerialization.data(withJSONObject: value))
    }

    func testCodePreservesLeadingZeroesAndRequiresExactlyEightASCIIDigits() throws {
        let waiting: [String: Any] = [
            "status": "waiting", "code": "00123456", "expiresAt": "2026-09-21T12:00:00.123Z",
        ]
        let state = try decode(waiting)
        XCTAssertEqual(state.code, "00123456")
        XCTAssertNotNil(state.expiration)
        XCTAssertTrue(state.isPending)
        XCTAssertFalse(state.isPaired)
        for invalid in ["1234567", "123456789", "ABCDEFGH", "１２３４５６７８", "1234 567"] {
            var payload = waiting
            payload["code"] = invalid
            XCTAssertThrowsError(try decode(payload), invalid)
        }
    }

    func testConfirmationCannotRenderWithoutItsNamedOrganisationAndPinnedClaim() throws {
        let confirmation: [String: Any] = [
            "status": "confirmation", "organizationName": "UnlikeOtherAI", "teamName": "Platform",
            "fingerprint": "SHA256:machine-key", "claimDigest": "reviewed-claim",
            "expiresAt": "2026-09-21T12:00:00Z",
        ]
        let state = try decode(confirmation)
        XCTAssertEqual(state.connectionName, "UnlikeOtherAI, in the Platform team")
        XCTAssertEqual(state.claimDigest, "reviewed-claim")
        XCTAssertTrue(state.isPending)
        XCTAssertFalse(state.isPaired)
        for required in ["organizationName", "fingerprint", "claimDigest", "expiresAt"] {
            var payload = confirmation
            payload.removeValue(forKey: required)
            XCTAssertThrowsError(try decode(payload), required)
        }
    }

    func testPairedConnectionUsesLiveNamesWithoutRequiringAPendingCode() throws {
        let state = try decode([
            "status": "paired", "organizationName": "Example", "teamName": NSNull(),
        ])
        XCTAssertTrue(state.isPaired)
        XCTAssertFalse(state.isPending)
        XCTAssertEqual(state.connectionName, "Example")
        XCTAssertNil(state.expiration)
    }

    func testUnknownStateAndUnparseableExpirationAreRefused() {
        XCTAssertThrowsError(try decode(["status": "confirmedAutomatically"]))
        XCTAssertThrowsError(try decode([
            "status": "waiting", "code": "12345678", "expiresAt": "later",
        ]))
    }
}
