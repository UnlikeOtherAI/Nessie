import Foundation
import XCTest

/// The exact bytes `nessie-executor describe --state-dir …` printed for the
/// paired development executor on 2026-09-16. Decoding this — rather than a
/// hand-written literal — is what proves the app renders the CLI's own answer,
/// and keeping a real wildcard entry in it proves the panels render a permitted
/// *command* rather than assuming a bare program name.
let describeFixtureJSON = """
{
  "apiBaseUrl": "http://127.0.0.1:5454",
  "executorId": "32b7de69-e303-46d6-b864-8a99a80d25e6",
  "policy": {
    "limits": {
      "maxCommandRuntimeSeconds": 30,
      "maxResultBytes": 65536,
      "maxSessions": 1
    },
    "operations": [
      "file.list",
      "file.read",
      "file.write",
      "workspace.review",
      "sandbox.stop"
    ],
    "permittedPrograms": [
      "git *",
      "node",
      "npm run *"
    ],
    "profiles": [
      "workspace_sandbox"
    ],
    "revision": 3
  },
  "reach": {
    "allowedOrigins": [],
    "workspaceRoot": "/Users/dictator/.nessie-executor-dev/workspace"
  },
  "sandbox": {
    "browserConfigured": false,
    "codingConfigured": false,
    "promotionHelperConfigured": false
  }
}
"""

func sampleDescription(
    file: StaticString = #filePath,
    line: UInt = #line
) -> ExecutorDescription {
    // swiftlint:disable:next force_try
    try! ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
}
