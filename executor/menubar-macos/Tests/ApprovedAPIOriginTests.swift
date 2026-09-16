import XCTest

final class ApprovedAPIOriginTests: XCTestCase {
    /// The rule copied from `approved_api_base_url` in
    /// `desktop/src-tauri/src/executor_companion.rs`: a development build reaches
    /// only its local API, a release only the production origin, and neither
    /// reaches anything else.
    func testADevelopmentBuildPairsOnlyWithTheLocalApi() {
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("http://127.0.0.1:5454", isDevelopmentBuild: true).get(),
            "http://127.0.0.1:5454"
        )
        XCTAssertNil(
            try? ApprovedAPIOrigin.approve("https://api.nessie.works", isDevelopmentBuild: true).get()
        )
    }

    func testAReleasePairsOnlyWithTheProductionApi() {
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("https://api.nessie.works", isDevelopmentBuild: false).get(),
            "https://api.nessie.works"
        )
        XCTAssertNil(
            try? ApprovedAPIOrigin.approve("http://127.0.0.1:5454", isDevelopmentBuild: false).get()
        )
    }

    func testNeitherBuildPairsWithAnythingElse() {
        for isDevelopment in [true, false] {
            for origin in [
                "https://example.test",
                "http://127.0.0.1:5455",
                "https://api.nessie.works.example.test",
                "http://localhost:5454",
                "",
            ] {
                XCTAssertNil(
                    try? ApprovedAPIOrigin.approve(origin, isDevelopmentBuild: isDevelopment).get(),
                    "\(origin) must be refused by a \(isDevelopment ? "development" : "release") build"
                )
            }
        }
    }

    func testTheRefusalNamesWhichBuildIsSpeaking() {
        guard case let .failure(development) =
            ApprovedAPIOrigin.approve("https://example.test", isDevelopmentBuild: true),
            case let .failure(release) =
            ApprovedAPIOrigin.approve("https://example.test", isDevelopmentBuild: false)
        else { return XCTFail("both builds must refuse an unapproved origin") }
        XCTAssertEqual(
            development.message,
            "A development Nessie Executor build may pair only with its local API origin."
        )
        XCTAssertEqual(
            release.message,
            "This Nessie Executor release may pair only with its approved API origin."
        )
    }
}
