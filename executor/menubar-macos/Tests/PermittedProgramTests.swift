import XCTest

final class PermittedProgramTests: XCTestCase {
    func testAddingKeepsTheListSortedSoReorderingIsNotANewRevision() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(adding: "git", to: ["node", "pnpm"]).get(),
            ["git", "node", "pnpm"]
        )
        XCTAssertEqual(try PermittedProgram.validate(adding: "  git  ", to: []).get(), ["git"])
    }

    /// The grammar `commandProgram` accepts in packages/schemas/src/executor.ts:
    /// bare names only, and never a shell.
    func testRefusesAnythingThatIsNotABareProgramName() {
        for program in ["", "   ", "/usr/bin/git", "bin/git", "sh", "bash", "zsh", "fish", "ksh", "dash"] {
            XCTAssertNil(
                try? PermittedProgram.validate(adding: program, to: []).get(),
                "\(program.debugDescription) must be refused"
            )
        }
    }

    func testRefusesADuplicateRatherThanQuietlyDroppingIt() {
        guard case let .failure(refusal) = PermittedProgram.validate(adding: "git", to: ["git"]) else {
            return XCTFail("a duplicate must be refused")
        }
        XCTAssertEqual(refusal.message, "git is already a permitted program.")
    }

    func testRefusesMoreProgramsThanThePolicyMayCarry() {
        let full = (0..<PermittedProgram.maximumCount).map { "program\($0)" }
        XCTAssertNil(try? PermittedProgram.validate(adding: "onemore", to: full).get())
        XCTAssertNotNil(try? PermittedProgram.validate(adding: "onemore", to: Array(full.dropLast())).get())
    }

    func testRemovingAProgramLeavesTheRest() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(
                removing: "node",
                from: ["git", "node", "pnpm"],
                commandRunEnabled: true
            ).get(),
            ["git", "pnpm"]
        )
    }

    /// The configure-time refusal, raised in the panel so a person hears it
    /// before the CLI does: `command.run` with no permitted program is an
    /// operation that can never succeed.
    func testEmptyingTheListIsRefusedWhileCommandRunIsEnabled() {
        guard case let .failure(refusal) = PermittedProgram.validate(
            removing: "git",
            from: ["git"],
            commandRunEnabled: true
        ) else { return XCTFail("emptying the list must be refused") }
        XCTAssertTrue(refusal.message.hasPrefix("Name at least one permitted program before enabling command.run."))
    }

    func testEmptyingTheListIsAllowedWhenCommandRunIsOff() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(removing: "git", from: ["git"], commandRunEnabled: false).get(),
            []
        )
    }

    func testRemovingSomethingThatIsNotOnTheListIsRefused() {
        XCTAssertNil(
            try? PermittedProgram.validate(
                removing: "curl",
                from: ["git"],
                commandRunEnabled: false
            ).get()
        )
    }
}
