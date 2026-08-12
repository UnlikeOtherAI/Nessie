import Foundation
import NessieExecutorVMCore

private func json(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}

private func usage() -> Never {
  fputs("Usage: nessie-executor-vm probe | validate --kernel <path> --disk <path> [--initrd <path>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n", stderr)
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

private func validate(_ arguments: [String]) throws {
  try requireSupportedHost()
  let cpuCount = Int(try option(arguments, "--cpus") ?? "2") ?? 0
  let memoryMiB = Int(try option(arguments, "--memory-mib") ?? "4096") ?? 0
  let kernelURL = try safeRegularFile(try requiredOption(arguments, "--kernel"))
  let diskURL = try safeRegularFile(try requiredOption(arguments, "--disk"))
  let initrdURL = try option(arguments, "--initrd").map(safeRegularFile)
  let input = VMInput(
    cpuCount: cpuCount,
    diskURL: diskURL,
    initrdURL: initrdURL,
    kernelURL: kernelURL,
    memoryMiB: memoryMiB,
  )
  if #available(macOS 15.0, *) {
    _ = try configuration(for: input)
    json(["valid": true])
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
    json(["code": "EXECUTOR_VM_CONFIGURATION_INVALID", "valid": false])
    return 1
  }
}

exit(run())
