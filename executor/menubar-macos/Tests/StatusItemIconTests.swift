import AppKit
import XCTest

final class StatusItemIconTests: XCTestCase {
    /// The rule the first version broke. A non-template status image is drawn in
    /// whatever colour the symbol carries, which on a dark or tinted menu bar is
    /// a mark a person cannot see — and `contentTintColor` does not apply to a
    /// non-template image, so the tint that was supposed to save it did nothing.
    func testEveryStateIsATemplateImage() {
        for icon in [MenuIcon.stopped, .running, .needsAttention] {
            XCTAssertTrue(
                StatusItemIcon.image(for: icon).isTemplate,
                "\(icon) must be a template image so the system tints it for this menu bar"
            )
        }
    }

    /// One silhouette, always the same size, so a person learns where it is once
    /// and does not have to hunt for a different picture each time the state
    /// changes.
    func testEveryStateOccupiesTheSameFootprint() {
        for icon in [MenuIcon.stopped, .running, .needsAttention] {
            XCTAssertEqual(StatusItemIcon.image(for: icon).size, StatusItemIcon.size)
        }
        XCTAssertEqual(StatusItemIcon.size, NSSize(width: 18, height: 18))
    }

    /// Same footprint is not the same picture: the three states have to be
    /// distinguishable from each other at a glance.
    func testEveryStateDrawsSomethingDifferent() throws {
        let drawn = try [MenuIcon.stopped, .running, .needsAttention].map { icon in
            try XCTUnwrap(StatusItemIcon.image(for: icon).tiffRepresentation)
        }
        for (index, image) in drawn.enumerated() {
            XCTAssertFalse(image.isEmpty, "state \(index) drew nothing at all")
            for (other, candidate) in drawn.enumerated() where index != other {
                XCTAssertNotEqual(image, candidate, "states \(index) and \(other) draw the same mark")
            }
        }
    }

    /// A template image is a mask, so the colour is the system's. What has to be
    /// true of the mask is that it is not empty — an all-transparent image is a
    /// status item that looks like it failed to launch.
    func testTheMarkActuallyCoversPartOfItsBox() throws {
        for icon in [MenuIcon.stopped, .running, .needsAttention] {
            let image = StatusItemIcon.image(for: icon)
            let cgImage = try XCTUnwrap(
                image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            )
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            var opaque = 0
            for x in 0..<bitmap.pixelsWide {
                for y in 0..<bitmap.pixelsHigh where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.2 {
                    opaque += 1
                }
            }
            let coverage = Double(opaque) / Double(bitmap.pixelsWide * bitmap.pixelsHigh)
            XCTAssertGreaterThan(coverage, 0.04, "\(icon) draws almost nothing")
            XCTAssertLessThan(coverage, 0.95, "\(icon) fills its whole box")
        }
    }

    func testEveryStateNamesItselfForVoiceOver() {
        XCTAssertEqual(StatusItemIcon.accessibilityDescription(for: .stopped), "Nessie Executor, stopped")
        XCTAssertEqual(StatusItemIcon.accessibilityDescription(for: .running), "Nessie Executor, running")
        XCTAssertEqual(
            StatusItemIcon.accessibilityDescription(for: .needsAttention),
            "Nessie Executor, needs attention"
        )
    }
}

final class ConsoleSectionTests: XCTestCase {
    /// The status menu has one line per section and each one has to land on that
    /// section: a menu line that opened the wrong screen is the navigation
    /// failure this window was built to fix.
    func testEveryMenuLineRoundTripsToItsSection() {
        XCTAssertEqual(ConsoleSection.allCases.count, 3)
        for section in ConsoleSection.allCases {
            XCTAssertEqual(ConsoleSection(rawValue: section.rawValue), section)
            XCTAssertEqual(section.menuTitle, "\(section.title)…")
            XCTAssertFalse(section.subtitle.isEmpty)
            XCTAssertFalse(section.symbolName.isEmpty)
        }
    }

    func testAnUnknownMenuIdSelectsNothing() {
        for raw in ["", "header", "quit", "Settings"] {
            XCTAssertNil(ConsoleSection(rawValue: raw), "\(raw.debugDescription) must select nothing")
        }
    }

    func testTheSelectorLabelsAreDistinct() {
        XCTAssertEqual(Set(ConsoleSection.allCases.map(\.title)).count, 3)
        XCTAssertEqual(Set(ConsoleSection.allCases.map(\.symbolName)).count, 3)
    }
}
