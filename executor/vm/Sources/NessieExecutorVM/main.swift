import Darwin
import Foundation
import NessieExecutorVMCore
import Virtualization

private func json(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}

private func usage() -> Never {
  fputs("Usage: nessie-executor-vm probe | validate --kernel <path> [--initrd <path>] [--disk <path>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n  nessie-executor-vm smoke --console <owner-only-path> --kernel <path> --initrd <path> [--disk <path>] [--timeout-seconds <1-30>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n", stderr)
  exit(64)
}

private func option(_ arguments: [String], _ name: String) throws -> String? {
  guard let index = arguments.firstIndex(of: name) else { return nil }
  guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("--") else {
    throw VMError.invalidArgument
  }
  return arguments[index + 1]
}

private func requiredOption(_ arguments: [String], _ name: String) throws -> String {
  guard let value = try option(arguments, name) else { throw VMError.invalidArgument }
  return value
}

private func parseInput(_ arguments: [String]) throws -> VMInput {
  try requireSupportedHost()
  let cpuCount = Int(try option(arguments, "--cpus") ?? "2") ?? 0
  let memoryMiB = Int(try option(arguments, "--memory-mib") ?? "4096") ?? 0
  let kernelURL = try safeRegularFile(try requiredOption(arguments, "--kernel"))
  let diskURL = try option(arguments, "--disk").map(safeRegularFile)
  let initrdURL = try option(arguments, "--initrd").map(safeRegularFile)
  return VMInput(
    cpuCount: cpuCount,
    diskURL: diskURL,
    initrdURL: initrdURL,
    kernelURL: kernelURL,
    memoryMiB: memoryMiB,
  )
}

private func validate(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  if #available(macOS 15.0, *) {
    _ = try configuration(for: input)
    json(["valid": true])
    return
  }
  throw VMError.unsupportedHost
}

private func safeConsoleFile(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeImage }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  let parent = url.deletingLastPathComponent()
  let resolvedParent = parent.resolvingSymlinksInPath()
  guard resolvedParent.path == parent.path else { throw VMError.unsafeImage }
  var parentMetadata = stat()
  guard lstat(parent.path, &parentMetadata) == 0, (parentMetadata.st_mode & S_IFMT) == S_IFDIR else {
    throw VMError.unsafeImage
  }
  guard parentMetadata.st_uid == getuid(), parentMetadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeImage
  }
  if !FileManager.default.fileExists(atPath: url.path) {
    let descriptor = open(url.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw VMError.unsafeImage }
    close(descriptor)
  }
  return try safeRegularFile(url.path)
}

private func waitForMainRunLoop(
  _ condition: () -> Bool,
  timeoutSeconds: Int,
) -> Bool {
  let deadline = Date(timeIntervalSinceNow: TimeInterval(timeoutSeconds))
  while !condition(), Date() < deadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
  }
  return condition()
}

private func smoke(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  let consoleURL = try safeConsoleFile(try requiredOption(arguments, "--console"))
  let timeout = Int(try option(arguments, "--timeout-seconds") ?? "8") ?? 0
  guard (1...30).contains(timeout) else { throw VMError.invalidArgument }
  guard input.initrdURL != nil else { throw VMError.invalidArgument }
  if #available(macOS 15.0, *) {
    let machine = VZVirtualMachine(configuration: try configuration(for: input, consoleURL: consoleURL))
    var didStart = false
    var startError: Error?
    machine.start { result in
      if case let .failure(error) = result { startError = error }
      didStart = true
    }
    guard waitForMainRunLoop({ didStart }, timeoutSeconds: 10), startError == nil else {
      throw startError ?? VMError.invalidArgument
    }
    _ = waitForMainRunLoop({ machine.state == .stopped }, timeoutSeconds: timeout)
    if machine.state != .stopped {
      var didStop = false
      var stopError: Error?
      machine.stop { error in
        stopError = error
        didStop = true
      }
      guard waitForMainRunLoop({ didStop }, timeoutSeconds: 10), stopError == nil else {
        throw stopError ?? VMError.invalidArgument
      }
    }
    json(["console": consoleURL.path, "smoke": "stopped"])
    return
  }
  throw VMError.unsupportedHost
}

private func run() -> Int32 {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let command = arguments.first else { usage() }
  do {
    switch command {
    case "probe":
      guard arguments.count == 1 else { usage() }
      let result = hostProbe()
      json(["architecture": result.architecture, "supported": result.supported])
    case "validate":
      try validate(Array(arguments.dropFirst()))
    case "smoke":
      try smoke(Array(arguments.dropFirst()))
    default:
      usage()
    }
    return 0
  } catch VMError.unsupportedHost {
    json(["code": "EXECUTOR_VM_UNSUPPORTED_HOST", "valid": false])
    return 1
  } catch VMError.unsafeImage {
    json(["code": "EXECUTOR_VM_UNSAFE_IMAGE", "valid": false])
    return 1
  } catch {
    fputs("nessie-executor-vm local failure: \((error as NSError).localizedDescription)\n", stderr)
    json(["code": "EXECUTOR_VM_CONFIGURATION_INVALID", "valid": false])
    return 1
  }
}

exit(run())
