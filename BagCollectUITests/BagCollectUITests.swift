import XCTest

final class BagCollectUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLaunchShowsMainNavigation() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["showcase-tab"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["add-collectible"].exists)
        XCTAssertTrue(app.buttons["library-tab"].exists)

        let protrusion = app.buttons["showcase-tab"].frame.minY
            - app.buttons["add-collectible"].frame.minY
        XCTAssertGreaterThanOrEqual(protrusion, 25)

        let homeScreenshot = XCTAttachment(screenshot: app.screenshot())
        homeScreenshot.name = "Editorial showcase"
        homeScreenshot.lifetime = .keepAlways
        add(homeScreenshot)

        if app.buttons["latest-feature-card"].exists {
            app.buttons["latest-feature-card"].tap()
            XCTAssertTrue(app.navigationBars["收藏详情"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.buttons["showcase-tab"].exists)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.buttons["showcase-tab"].waitForExistence(timeout: 3))
        }

        app.buttons["library-tab"].tap()
        XCTAssertTrue(app.staticTexts["全部收藏"].waitForExistence(timeout: 3))

        let libraryScreenshot = XCTAttachment(screenshot: app.screenshot())
        libraryScreenshot.name = "Editorial library"
        libraryScreenshot.lifetime = .keepAlways
        add(libraryScreenshot)

        app.buttons["add-collectible"].tap()
        XCTAssertTrue(app.navigationBars["添加收藏"].waitForExistence(timeout: 3))

        let addScreenshot = XCTAttachment(screenshot: app.screenshot())
        addScreenshot.name = "Editorial add flow"
        addScreenshot.lifetime = .keepAlways
        add(addScreenshot)
    }
}
