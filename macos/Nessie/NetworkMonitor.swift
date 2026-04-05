import Foundation
import Network

class NetworkMonitor: ObservableObject {
  @Published var isConnected = true

  private let monitor = NWPathMonitor()

  init() {
    monitor.pathUpdateHandler = { [weak self] path in
      DispatchQueue.main.async {
        self?.isConnected = path.status == .satisfied
      }
    }
    monitor.start(queue: DispatchQueue(label: "NetworkMonitor"))
  }

  deinit {
    monitor.cancel()
  }
}
