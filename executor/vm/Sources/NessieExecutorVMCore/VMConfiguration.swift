import Darwin
import Foundation
import Virtualization

public enum VMError: Error {
  case guestHandshake
  case invalidArgument
  case unsupportedHost
  case unsafeImage
}

public struct VMInput {
  public let cpuCount: Int
  public let diskURL: URL?
  public let initrdURL: URL?
  public let kernelURL: URL
  public let memoryMiB: Int

  public init(
    cpuCount: Int,
    diskURL: URL?,
    initrdURL: URL?,
    kernelURL: URL,
    memoryMiB: Int,
  ) {
    self.cpuCount = cpuCount
    self.diskURL = diskURL
    self.initrdURL = initrdURL
    self.kernelURL = kernelURL
    self.memoryMiB = memoryMiB
  }
}

public struct VMHostProbe {
  public let architecture: String
  public let supported: Bool
}

public func safeRegularFile(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeImage }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  var metadata = stat()
  guard lstat(url.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1 else {
    throw VMError.unsafeImage
  }
  guard metadata.st_uid == getuid(), metadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeImage
  }
  let resolved = url.resolvingSymlinksInPath()
  guard resolved.path == url.path else { throw VMError.unsafeImage }
  return resolved
}

public func hostProbe() -> VMHostProbe {
  #if arch(arm64)
  let architecture = "arm64"
  #else
  let architecture = "unsupported"
  #endif
  let supported: Bool
  if #available(macOS 15.0, *), architecture == "arm64" {
    supported = true
  } else {
    supported = false
  }
  return VMHostProbe(architecture: architecture, supported: supported)
}

public func requireSupportedHost() throws {
  guard hostProbe().supported else { throw VMError.unsupportedHost }
}

@available(macOS 15.0, *)
public func configuration(
  for input: VMInput,
  consoleURL: URL? = nil,
  enableGuestControl: Bool = false,
) throws -> VZVirtualMachineConfiguration {
  guard (1...4).contains(input.cpuCount), (2048...8192).contains(input.memoryMiB) else {
    throw VMError.invalidArgument
  }
  let loader = VZLinuxBootLoader(kernelURL: input.kernelURL)
  loader.commandLine = input.diskURL == nil
    ? "console=hvc0 rdinit=/init panic=-1"
    : "console=hvc0 root=/dev/vda ro panic=-1"
  loader.initialRamdiskURL = input.initrdURL

  let configuration = VZVirtualMachineConfiguration()
  configuration.bootLoader = loader
  configuration.cpuCount = input.cpuCount
  configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  configuration.memorySize = UInt64(input.memoryMiB) * 1_024 * 1_024
  if let diskURL = input.diskURL {
    let disk = try VZDiskImageStorageDeviceAttachment(url: diskURL, readOnly: true)
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
  }
  if let consoleURL {
    let consoleOutput = try FileHandle(forWritingTo: consoleURL)
    try consoleOutput.truncate(atOffset: 0)
    let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
    serialPort.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/null")),
      fileHandleForWriting: consoleOutput,
    )
    configuration.serialPorts = [serialPort]
  }
  if enableGuestControl {
    configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  }

  // Guest control is a per-VM virtio socket, never a network adapter or host
  // filesystem bridge. The broker must still add COW and forced egress before
  // executable browser or coding descriptors can be advertised.
  try configuration.validate()
  return configuration
}
