import SwiftUI

struct APIKeysView: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var keys: [JSONValue] = []
    @State private var name = ""
    @State private var created: String?
    @State private var revokeId: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            if let created {
                Section("Save your new key") {
                    Text("This key is shown once. Keep it somewhere secure.").foregroundStyle(.secondary)
                    Text(created).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    Button("I’ve saved it") { self.created = nil }
                }
            }
            Section("Your keys") {
                ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(key["name"].text).font(.headline)
                        Text(key["prefix"].text + "…").font(.caption.monospaced()).foregroundStyle(.secondary)
                        Button("Revoke key", role: .destructive) { revokeId = key["id"].text }
                    }
                }
            }
            Section("New key") {
                TextField("Key name", text: $name)
                Button("Create key") { Task { await create() } }.disabled(name.isEmpty || busy)
            }
            if let error {
                ErrorNotice(message: error)
                Button("Try again") { Task { await load() } }
            }
        }.navigationTitle("API keys").task { await load() }
            .confirmationDialog(
                "Revoke this key?",
                isPresented: Binding(
                    get: { revokeId != nil }, set: { if !$0 { revokeId = nil } }
                )
            ) {
                if let revokeId {
                    Button("Revoke key", role: .destructive) { Task { await revoke(revokeId) } }
                }
            }
    }
    private func load() async {
        do {
            keys = try await api.request("/v1/admin/keys")["keys"].array
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func create() async {
        busy = true
        defer { busy = false }
        do {
            created = try await api.request(
                "/v1/admin/keys", method: "POST",
                body: .object(["name": .string(name)]))["key"].string
            name = ""
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func revoke(_ id: String) async {
        do {
            _ = try await api.request(
                "/v1/admin/keys/" + DeepWaterAPI.pathComponent(id), method: "DELETE")
            await load()
        } catch { self.error = error.localizedDescription }
    }
}
