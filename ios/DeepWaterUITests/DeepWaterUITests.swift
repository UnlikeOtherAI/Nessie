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
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "reportContent").firstMatch.waitForExistence(timeout: 10))
        capture("Report")
        app.buttons["Sources"].tap()
        XCTAssertTrue(app.staticTexts["Energy storage — IEA"].waitForExistence(timeout: 5))
        capture("Sources")
    }

    @MainActor func testCreateResearchAndRetryUncertainLaunch() {
        launch(["--launch-uncertain"])
        XCTAssertTrue(app.buttons["newResearch"].waitForExistence(timeout: 10))
        app.buttons["newResearch"].tap()
        let question = app.textFields["researchQuestion"]
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        question.tap()
        question.typeText("How can cities reduce heat?")
        app.swipeUp()
        app.buttons["startResearch"].tap()
        XCTAssertTrue(
            app.staticTexts["A launch is waiting to be confirmed"].waitForExistence(timeout: 10))
        capture("Retry")
        app.buttons["startResearch"].tap()
        XCTAssertTrue(app.staticTexts["Getting ready"].waitForExistence(timeout: 10))
    }

    @MainActor func testEmptyAndOfflineRecoveryAreVisible() {
        launch(["--empty"])
        XCTAssertTrue(app.staticTexts["Your next discovery starts here"].waitForExistence(timeout: 10))
        capture("Empty")
        app.terminate()
        launch(["--offline"])
        XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 10))
        capture("Offline")
    }

    @MainActor func testNativeAccountAndSignOut() {
        launch()
        XCTAssertTrue(app.buttons["account"].waitForExistence(timeout: 10))
        app.buttons["account"].tap()
        XCTAssertTrue(app.staticTexts["Alex Morgan"].waitForExistence(timeout: 5))
        capture("Account")
        app.buttons["Plan and credits"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "1,240 credits"))
            .firstMatch.waitForExistence(timeout: 5))
        capture("Plan")
        app.navigationBars.buttons["Account"].tap()
        app.buttons["People"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "alex@example.test"))
            .firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons["Account"].tap()
        app.swipeUp()
        app.buttons["signOut"].tap()
        XCTAssertTrue(app.buttons["signIn"].waitForExistence(timeout: 5))
        capture("SignIn")
    }

    @MainActor func testProjectCreationAndSelection() {
        launch()
        XCTAssertTrue(app.buttons["projects"].waitForExistence(timeout: 10))
        app.buttons["projects"].tap()
        let name = app.textFields["projectName"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("City resilience")
        app.buttons["Create project"].tap()
        XCTAssertTrue(app.navigationBars["City resilience"].waitForExistence(timeout: 5))
        app.buttons["projects"].tap()
        XCTAssertTrue(app.buttons["City resilience"].waitForExistence(timeout: 5))
        capture("Projects")
        app.buttons["All research"].tap()
        XCTAssertTrue(app.navigationBars["Research"].waitForExistence(timeout: 5))
    }

    @MainActor func testAdaptiveOrientation() {
        launch()
        XCTAssertTrue(app.buttons["newResearch"].waitForExistence(timeout: 10))
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
