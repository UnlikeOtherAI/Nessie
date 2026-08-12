import Virtualization

/** A guest connects outward to this fixed port; the host never opens a guest socket. */
public let nessieGuestControlPort: UInt32 = 49_152

public enum GuestControlError: Error {
  case unavailable
}

/**
 * Owns the one guest-initiated control channel for a micro-VM. The listener is
 * installed only on that VM's virtio device, accepts one connection at the
 * fixed port, and has no host network listener or ability to reach another VM.
 *
 * The future guest broker owns framing/authentication over this connection. It
 * must call finishConnection after the bounded session ends; otherwise this
 * object deliberately rejects another connection instead of replacing a live
 * control channel.
 */
@available(macOS 15.0, *)
public final class GuestControlListener: NSObject, VZVirtioSocketListenerDelegate {
  private var activeConnection: VZVirtioSocketConnection?
  private weak var socketDevice: VZVirtioSocketDevice?
  private let listener = VZVirtioSocketListener()
  private let onConnection: (VZVirtioSocketConnection) -> Bool

  public init(onConnection: @escaping (VZVirtioSocketConnection) -> Bool) {
    self.onConnection = onConnection
    super.init()
    listener.delegate = self
  }

  public func attach(to virtualMachine: VZVirtualMachine) throws {
    guard socketDevice == nil, activeConnection == nil else { throw GuestControlError.unavailable }
    guard let device = virtualMachine.socketDevices.compactMap({ $0 as? VZVirtioSocketDevice }).first else {
      throw GuestControlError.unavailable
    }
    device.setSocketListener(listener, forPort: nessieGuestControlPort)
    socketDevice = device
  }

  public func finishConnection() {
    activeConnection?.close()
    activeConnection = nil
  }

  public func invalidate() {
    socketDevice?.removeSocketListener(forPort: nessieGuestControlPort)
    socketDevice = nil
    finishConnection()
  }

  public func listener(
    _ listener: VZVirtioSocketListener,
    shouldAcceptNewConnection connection: VZVirtioSocketConnection,
    from socketDevice: VZVirtioSocketDevice,
  ) -> Bool {
    guard socketDevice === self.socketDevice, activeConnection == nil else { return false }
    guard connection.destinationPort == nessieGuestControlPort, onConnection(connection) else { return false }
    activeConnection = connection
    return true
  }
}
