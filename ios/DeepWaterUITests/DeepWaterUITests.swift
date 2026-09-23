import XCTest

final class DeepWaterUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor private func launch(_ arguments: [String] = []) {
        app.launchArguments = ["--ui-testing"] + arguments
        app.launch()
    }

    @MainActor func testReportSourcesAndAccount() {
        launch()
        let row = app.buttons["run-11111111-1111-4111-8111-111111111111"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "reportContent").firstMatch.waitForExistence(timeout: 30))
        capture("Report")
        app.buttons["Sources"].tap()
        XCTAssertTrue(app.staticTexts["Energy storage — IEA"].waitForExistence(timeout: 15))
        capture("Sources")
    }

    @MainActor func testCreateResearchAndRetryUncertainLaunch() {
        launch(["--launch-uncertain"])
        XCTAssertTrue(app.buttons["newResearch"].waitForExistence(timeout: 30))
        app.buttons["newResearch"].tap()
        let question = app.textFields["researchQuestion"]
        XCTAssertTrue(question.waitForExistence(timeout: 15))
        question.tap()
        question.typeText("How can cities reduce heat?")
        app.swipeUp()
        app.buttons["startResearch"].tap()
        XCTAssertTrue(
            app.staticTexts["A launch is waiting to be confirmed"].waitForExistence(timeout: 30))
        capture("Retry")
        app.buttons["startResearch"].tap()
        XCTAssertTrue(app.staticTexts["Getting ready"].waitForExistence(timeout: 30))
    }

    @MainActor func testEmptyAndOfflineRecoveryAreVisible() {
        launch(["--empty"])
        XCTAssertTrue(app.staticTexts["Your next discovery starts here"].waitForExistence(timeout: 30))
        capture("Empty")
        app.terminate()
        launch(["--offline"])
        XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["You’re offline. Check your connection and try again."].exists)
        capture("Offline")
    }

    @MainActor func testNativeAccountAndSignOut() {
        launch()
        XCTAssertTrue(app.buttons["account"].waitForExistence(timeout: 30))
        app.buttons["account"].tap()
        XCTAssertTrue(app.staticTexts["Alex Morgan"].waitForExistence(timeout: 15))
        capture("Account")
        app.buttons["Plan and credits"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "1,240 credits"))
            .firstMatch.waitForExistence(timeout: 15))
        capture("Plan")
        app.navigationBars["Plan and credits"].buttons["BackButton"].tap()
        app.buttons["People"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "alex@example.test"))
            .firstMatch.waitForExistence(timeout: 15))
        app.navigationBars["People"].buttons["BackButton"].tap()
        app.swipeUp()
        app.buttons["signOut"].tap()
        XCTAssertTrue(app.buttons["signIn"].waitForExistence(timeout: 15))
        capture("SignIn")
    }

    @MainActor func testProjectCreationAndSelection() {
        launch()
        XCTAssertTrue(app.buttons["projects"].waitForExistence(timeout: 30))
        app.buttons["projects"].tap()
        let name = app.textFields["projectName"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        name.tap()
        name.typeText("City resilience")
        app.buttons["Create project"].tap()
        XCTAssertTrue(app.navigationBars["City resilience"].waitForExistence(timeout: 15))
        app.buttons["projects"].tap()
        XCTAssertTrue(app.buttons["City resilience"].waitForExistence(timeout: 15))
        capture("Projects")
        app.buttons["All research"].tap()
        XCTAssertTrue(app.navigationBars["Research"].waitForExistence(timeout: 15))
    }

    @MainActor func testAdaptiveOrientation() {
        launch()
        XCTAssertTrue(app.buttons["newResearch"].waitForExistence(timeout: 30))
        XCUIDevice.shared.orientation = .landscapeLeft
        capture("Landscape")
        let frame = app.frame
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertGreaterThan(frame.height, frame.width)
        } else {
            XCTAssertGreaterThan(frame.width, frame.height)
        }
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
