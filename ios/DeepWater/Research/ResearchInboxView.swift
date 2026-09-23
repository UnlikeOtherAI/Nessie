import SwiftUI

struct ResearchInboxView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    let onOpen: (String) -> Void
    @State private var runs: [ResearchRun] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                if !loaded && error == nil { ProgressView("Checking for updates…") }
                ForEach(runs) { run in
                    Button { onOpen(run.id); dismiss() } label: { RunRow(run: run) }
                        .buttonStyle(.plain)
                }
                if let error { ErrorNotice(message: error); Button("Try again") { Task { await load() } } }
                if loaded && runs.isEmpty {
                    ContentUnavailableView("You’re up to date", systemImage: "bell",
                                           description: Text("Finished research and issues appear here."))
                }
            }
            .navigationTitle("Updates")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }.refreshable { await load() }
        }
    }

    private func load() async {
        do {
            let value = try await api.request("/v1/admin/runs?limit=50&order=activity")
            runs = try value["runs"].array.map(ResearchRun.init).filter { ["complete", "failed"].contains($0.status) }
            loaded = true
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
