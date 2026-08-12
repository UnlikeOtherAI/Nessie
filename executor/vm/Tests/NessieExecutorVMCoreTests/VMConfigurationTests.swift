import Foundation
import Testing
@testable import NessieExecutorVMCore

@Test("the VM bootstrap reports a concrete architecture and support decision")
func probeReportsSupportDecision() {
  let probe = hostProbe()
  #expect(!probe.architecture.isEmpty)
  #expect(!probe.supported || probe.architecture == "arm64")
}

@Test("guest images must be absolute owner-safe regular files")
func guestImagesRejectUnsafePaths() throws {
  #expect(throws: VMError.self) {
    try safeRegularFile("relative-kernel")
  }
  let sourceFile = URL(fileURLWithPath: #filePath).standardizedFileURL.path
  let resolved = try safeRegularFile(sourceFile)
  #expect(resolved.path == sourceFile)
}
