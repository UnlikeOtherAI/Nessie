import Combine
import Foundation
import SwiftUI

/// One controller per account: selecting a view never stops another connection.
@MainActor
final class ExecutorConnections: ObservableObject {
    @Published private(set) var controllers: [ExecutorController]
    @Published var selectedDirectory: String
    private let isDevelopmentBuild: Bool
    private var observations: Set<AnyCancellable> = []

    var selected: ExecutorController {
        controllers.first { $0.stateDirectory == selectedDirectory } ?? controllers[0]
    }

    init(isDevelopmentBuild: Bool) {
        self.isDevelopmentBuild = isDevelopmentBuild
        let initialControllers: [ExecutorController]
        switch ExecutorPaths.discover(isDevelopmentBuild: isDevelopmentBuild) {
        case let .success(directories):
            initialControllers = directories.map {
                ExecutorController(isDevelopmentBuild: isDevelopmentBuild, stateDirectory: $0)
            }
        case let .failure(refusal):
            initialControllers = [ExecutorController(
                isDevelopmentBuild: isDevelopmentBuild,
                stateDirectory: ExecutorPaths.stateDirectory(isDevelopmentBuild: isDevelopmentBuild),
                refusal: refusal
            )]
        }
        controllers = initialControllers
        selectedDirectory = initialControllers[0].stateDirectory
        controllers.forEach(observe)
    }

    private func observe(_ controller: ExecutorController) {
        controller.objectWillChange.merge(with: controller.pairing.objectWillChange)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &observations)
    }

    func label(_ controller: ExecutorController) -> String {
        let pairing = controller.pairing.state
        let name = [pairing?.machineName, pairing?.connectionName].compactMap { $0 }.joined(separator: " · ")
        let server = pairing?.apiBaseUrl ?? controller.model.description?.apiBaseUrl
        return server.map { "\(name) · \($0)" } ?? "New account"
    }

    func add() {
        if let unfinished = controllers.first(where: {
            !ExecutorPaths.hasPairingFile($0.stateDirectory)
        }) {
            selectedDirectory = unfinished.stateDirectory
            return
        }
        let controller = ExecutorController(
            isDevelopmentBuild: isDevelopmentBuild,
            stateDirectory: ExecutorPaths.newConnectionDirectory(isDevelopmentBuild: isDevelopmentBuild)
        )
        controllers.append(controller)
        observe(controller)
        selectedDirectory = controller.stateDirectory
        controller.start()
    }

    func start() { controllers.forEach { $0.start() } }
    func shutdown() { controllers.forEach { $0.shutdown() } }
}

struct ConnectionConsoleView: View {
    @ObservedObject var connections: ExecutorConnections

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Account", selection: $connections.selectedDirectory) {
                    ForEach(connections.controllers, id: \.stateDirectory) { controller in
                        Text(connections.label(controller)).tag(controller.stateDirectory)
                    }
                }
                Button("Add account") { connections.add() }
            }.padding(20)
            Divider()
            ConsoleView()
                .id(connections.selectedDirectory)
                .environmentObject(connections.selected)
                .environmentObject(connections.selected.pairing)
        }.frame(width: 560)
    }
}
