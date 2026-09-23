import SwiftUI

struct AccountView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var signingOut = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let identity = api.identity {
                    Section("Signed in") {
                        if !identity.name.isEmpty { Text(identity.name).font(.headline) }
                        if !identity.email.isEmpty { Text(identity.email).textSelection(.enabled) }
                        NavigationLink("Switch team") { TeamSwitcher() }
                    }
                }
                Section("Your team") {
                    NavigationLink {
                        MembersView()
                    } label: {
                        Label("People", systemImage: "person.2")
                    }
                    NavigationLink {
                        BillingView()
                    } label: {
                        Label("Plan and credits", systemImage: "creditcard")
                    }
                }
                Section("Connections") {
                    NavigationLink {
                        APIKeysView()
                    } label: {
                        Label("API keys", systemImage: "key")
                    }
                    NavigationLink {
                        WebhookView()
                    } label: {
                        Label("Webhook", systemImage: "link")
                    }
                }
                Section {
                    if let url = URL(string: DeepWaterAPI.webOrigin) {
                        Link("DeepWater on the web", destination: url)
                    }
                    if let url = URL(string: "https://docs.deepwater.live") {
                        Link("Help and documentation", destination: url)
                    }
                }
                Section {
                    Button("Sign out", role: .destructive) { Task { await signOut() } }
                        .disabled(signingOut).accessibilityIdentifier("signOut")
                    if let error { ErrorNotice(message: error) }
                }
            }.navigationTitle("Account")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func signOut() async {
        signingOut = true
        defer { signingOut = false }
        do { try await api.signOut() } catch { self.error = error.localizedDescription }
    }
}

struct TeamSwitcher: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var directory: JSONValue = .null
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        List {
            if directory == .null && error == nil { ProgressView("Loading teams…") }
            if directory["source"].text == "session" {
                Text("The team directory is temporarily unavailable. Your current team is shown below.")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(directory["organizations"].array.enumerated()), id: \.offset) { _, organization in
                Section(organization["name"].string ?? "Organization") {
                    ForEach(Array(organization["teams"].array.enumerated()), id: \.offset) { _, team in
                        Button {
                            Task { await switchTeam(organization, team: team) }
                        } label: {
                            HStack {
                                Text(team["name"].string ?? "Current team")
                                Spacer()
                                if team["active"].bool { Image(systemName: "checkmark") }
                            }
                        }.disabled(busy || team["active"].bool)
                    }
                }
            }
            if let error {
                ErrorNotice(message: error)
                Button("Try again") { Task { await load() } }
            }
        }.navigationTitle("Switch team").task { await load() }
    }
    private func load() async {
        do {
            directory = try await api.request("/v1/auth/workspaces")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func switchTeam(_ organization: JSONValue, team: JSONValue) async {
        busy = true
        defer { busy = false }
        do {
            try await api.switchTeam(org: organization["orgId"].text, team: team["teamId"].text)
        } catch { self.error = error.localizedDescription }
    }
}

struct WebhookView: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var address = ""
    @State private var message: String?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                TextField("https://example.com/webhook", text: $address).keyboardType(.URL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            } header: {
                Text("Webhook URL")
            } footer: {
                Text("Receive research updates in your own service. Leave blank to disable.")
            }
            Button("Save") { Task { await save() } }.disabled(busy)
            if let message { Text(message).foregroundStyle(.secondary) }
            if let error { ErrorNotice(message: error) }
        }.navigationTitle("Webhook").task {
            do { address = try await api.request("/v1/admin/profile")["webhook_url"].text } catch {
                self.error = error.localizedDescription
            }
        }
    }
    private func save() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.request(
                "/v1/admin/settings", method: "POST",
                body: .object([
                    "webhook_url": address.isEmpty ? .null : .string(address)
                ]))
            error = nil
            message = "Saved"
        } catch { self.error = error.localizedDescription }
    }
}
