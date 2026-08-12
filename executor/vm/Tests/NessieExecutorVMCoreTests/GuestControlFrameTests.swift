import Foundation
import Testing
@testable import NessieExecutorVMCore

@Test("guest control frames round-trip one bounded request")
func guestControlFrameRoundTrip() throws {
  let original = GuestControlEnvelope(
    kind: .request,
    payload: Data("{\"operation\":\"browser.open\"}".utf8),
    requestId: UUID(),
  )
  let frame = try GuestControlFrameCodec.encode(original)
  #expect(frame.count <= guestControlFrameMaxBytes)
  #expect(try GuestControlFrameCodec.decode(frame) == original)
}

@Test("guest control hello requires one fixed-size bootstrap token")
func guestControlHelloToken() throws {
  let hello = GuestControlEnvelope(
    kind: .hello,
    payload: Data(),
    requestId: UUID(),
    sessionToken: String(repeating: "a", count: 43),
  )
  #expect(try GuestControlFrameCodec.decode(GuestControlFrameCodec.encode(hello)) == hello)
  #expect(throws: GuestControlFrameError.self) {
    try GuestControlFrameCodec.encode(GuestControlEnvelope(
      kind: .hello,
      payload: Data(),
      requestId: UUID(),
      sessionToken: "not-a-boot-token",
    ))
  }
}

@Test("guest control rejects malformed or oversized length-delimited input")
func guestControlFrameBounds() throws {
  #expect(throws: GuestControlFrameError.self) {
    try GuestControlFrameCodec.decode(Data([0, 0, 0, 2, 123]))
  }
  #expect(throws: GuestControlFrameError.self) {
    try GuestControlFrameCodec.encode(GuestControlEnvelope(
      kind: .response,
      payload: Data(repeating: 1, count: guestControlPayloadMaxBytes + 1),
      requestId: UUID(),
    ))
  }
}
