import Darwin
import Dispatch
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
    sessionToken: String(repeating: "A", count: 43),
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
  #expect(throws: GuestControlFrameError.self) {
    try GuestControlFrameCodec.encode(GuestControlEnvelope(
      kind: .hello,
      payload: Data(),
      requestId: UUID(),
      sessionToken: String(repeating: "a", count: 43),
    ))
  }
}

@Test("guest egress token is distinct from the bootstrap hello token")
func guestEgressToken() throws {
  let bootstrap = String(repeating: "A", count: 43)
  #expect(try guestEgressToken(fromBootstrapToken: bootstrap) == "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo")
}

@Test("guest egress tunnel has one fixed distinct-session prelude")
func guestEgressTunnelPrelude() throws {
  let token = "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo"
  let prelude = try GuestEgressTunnelCodec.encodePrelude(sessionToken: token)
  #expect(prelude.count == guestEgressPreludeBytes)
  #expect(prelude == Data([0x4e, 0x45, 0x58, 0x47, 1]) + Data(token.utf8))
  #expect(try GuestEgressTunnelCodec.decodePrelude(prelude) == token)
  #expect(throws: GuestEgressTunnelError.self) {
    try GuestEgressTunnelCodec.decodePrelude(Data([0x4e, 0x45, 0x58, 0x47, 1]))
  }
  #expect(throws: GuestEgressTunnelError.self) {
    try GuestEgressTunnelCodec.decodePrelude(Data([0x4e, 0x45, 0x58, 0x47, 2]) + Data(token.utf8))
  }
}

@Test("guest egress admission releases only a verified tunnel descriptor")
func guestEgressAdmissionSession() throws {
  var descriptors = [Int32](repeating: -1, count: 2)
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
    throw NSError(domain: "GuestEgressTest", code: 0)
  }
  let host = descriptors[0]
  let guest = descriptors[1]
  defer {
    close(host)
    close(guest)
  }

  let authenticated = DispatchSemaphore(value: 0)
  let terminated = DispatchSemaphore(value: 0)
  let token = "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo"
  let session = try GuestEgressTunnelSession(
    fileDescriptor: host,
    expectedSessionToken: token,
    onAuthenticated: { authenticated.signal() },
    onTerminated: { _ in terminated.signal() },
  )
  try session.start()
  try writeGuestBytes(GuestEgressTunnelCodec.encodePrelude(sessionToken: token), to: guest)
  #expect(authenticated.wait(timeout: .now() + 1) == .success)
  session.stop()
  #expect(terminated.wait(timeout: .now() + 0.05) == .timedOut)
}

@Test("guest egress admission rejects a different canonical session proof")
func guestEgressAdmissionRejectsWrongToken() throws {
  var descriptors = [Int32](repeating: -1, count: 2)
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
    throw NSError(domain: "GuestEgressTest", code: 1)
  }
  let host = descriptors[0]
  let guest = descriptors[1]
  defer {
    close(host)
    close(guest)
  }

  let authenticated = DispatchSemaphore(value: 0)
  let terminated = DispatchSemaphore(value: 0)
  let session = try GuestEgressTunnelSession(
    fileDescriptor: host,
    expectedSessionToken: "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo",
    onAuthenticated: { authenticated.signal() },
    onTerminated: { _ in terminated.signal() },
  )
  try session.start()
  try writeGuestBytes(
    GuestEgressTunnelCodec.encodePrelude(sessionToken: String(repeating: "A", count: 43)),
    to: guest,
  )
  #expect(terminated.wait(timeout: .now() + 1) == .success)
  #expect(authenticated.wait(timeout: .now() + 0.05) == .timedOut)
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

@Test("guest control refuses all guest work until its exact boot hello")
func guestControlConversationAuthenticatesExactlyOnce() throws {
  let token = String(repeating: "A", count: 43)
  let conversation = try GuestControlConversation(expectedBootstrapToken: token)
  let requestId = UUID()

  #expect(throws: GuestControlProtocolError.self) {
    try conversation.beginRequest(requestId)
  }
  #expect(throws: GuestControlProtocolError.self) {
    try conversation.receive(GuestControlEnvelope(
      kind: .request,
      payload: Data(),
      requestId: requestId,
    ))
  }
  #expect(try conversation.receive(GuestControlEnvelope(
    kind: .hello,
    payload: Data(),
    requestId: UUID(),
    sessionToken: token,
  )) == .authenticated)
  #expect(throws: GuestControlProtocolError.self) {
    try conversation.receive(GuestControlEnvelope(
      kind: .hello,
      payload: Data(),
      requestId: UUID(),
      sessionToken: token,
    ))
  }

  try conversation.beginRequest(requestId)
  #expect(throws: GuestControlProtocolError.self) {
    try conversation.receive(GuestControlEnvelope(
      kind: .response,
      payload: Data(),
      requestId: UUID(),
    ))
  }
  let response = GuestControlEnvelope(kind: .response, payload: Data("ok".utf8), requestId: requestId)
  #expect(try conversation.receive(response) == .response(response))
}

@Test("guest control stream parser handles fragmented bounded frames")
func guestControlFrameStreamParser() throws {
  let first = try GuestControlFrameCodec.encode(GuestControlEnvelope(
    kind: .response,
    payload: Data("one".utf8),
    requestId: UUID(),
  ))
  let second = try GuestControlFrameCodec.encode(GuestControlEnvelope(
    kind: .close,
    payload: Data(),
    requestId: UUID(),
  ))
  let parser = GuestControlFrameStreamDecoder()
  #expect(try parser.append(first.prefix(3)).isEmpty)
  var remaining = Data(first.dropFirst(3))
  remaining.append(second)
  #expect(try parser.append(remaining).count == 2)
}

@Test("guest control host session verifies hello before issuing one request")
func guestControlHostSession() throws {
  var descriptors = [Int32](repeating: -1, count: 2)
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
    throw NSError(domain: "GuestControlTest", code: 0)
  }
  let host = descriptors[0]
  let guest = descriptors[1]
  defer { close(guest) }

  let authenticated = DispatchSemaphore(value: 0)
  let responded = DispatchSemaphore(value: 0)
  let terminated = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var receivedResponse: GuestControlEnvelope?
  let session = try GuestControlSession(
    fileDescriptor: host,
    expectedBootstrapToken: String(repeating: "A", count: 43),
    onAuthenticated: { authenticated.signal() },
    onResponse: { response in
      lock.lock()
      receivedResponse = response
      lock.unlock()
      responded.signal()
    },
    onTerminated: { _ in terminated.signal() },
  )
  defer {
    session.stop()
    _ = terminated.wait(timeout: .now() + 1)
  }
  try session.start()

  try writeGuestFrame(GuestControlEnvelope(
    kind: .hello,
    payload: Data(),
    requestId: UUID(),
    sessionToken: String(repeating: "A", count: 43),
  ), to: guest)
  #expect(authenticated.wait(timeout: .now() + 1) == .success)

  let requestId = try session.sendRequest(payload: Data("open".utf8))
  let request = try GuestControlFrameCodec.decode(readGuestFrame(from: guest))
  #expect(request.kind == .request)
  #expect(request.requestId == requestId)
  try writeGuestFrame(GuestControlEnvelope(
    kind: .response,
    payload: Data("opened".utf8),
    requestId: requestId,
  ), to: guest)
  #expect(responded.wait(timeout: .now() + 1) == .success)
  lock.lock()
  #expect(receivedResponse?.payload == Data("opened".utf8))
  lock.unlock()
}

private func writeGuestFrame(_ envelope: GuestControlEnvelope, to descriptor: Int32) throws {
  try writeGuestBytes(GuestControlFrameCodec.encode(envelope), to: descriptor)
}

private func writeGuestBytes(_ value: Data, to descriptor: Int32) throws {
  var remaining = value
  while !remaining.isEmpty {
    let count = remaining.withUnsafeBytes { bytes in
      Darwin.write(descriptor, bytes.baseAddress, bytes.count)
    }
    guard count > 0 else { throw NSError(domain: "GuestControlTest", code: 1) }
    remaining.removeFirst(Int(count))
  }
}

private func readGuestFrame(from descriptor: Int32) throws -> Data {
  var header = try readGuestBytes(4, from: descriptor)
  let bodyLength = header.reduce(UInt32(0)) { partial, byte in
    (partial << 8) | UInt32(byte)
  }
  header.append(try readGuestBytes(Int(bodyLength), from: descriptor))
  return header
}

private func readGuestBytes(_ count: Int, from descriptor: Int32) throws -> Data {
  var result = Data()
  while result.count < count {
    var chunk = [UInt8](repeating: 0, count: count - result.count)
    let readCount = chunk.withUnsafeMutableBytes { bytes in
      Darwin.read(descriptor, bytes.baseAddress, bytes.count)
    }
    guard readCount > 0 else { throw NSError(domain: "GuestControlTest", code: 2) }
    result.append(contentsOf: chunk.prefix(Int(readCount)))
  }
  return result
}
