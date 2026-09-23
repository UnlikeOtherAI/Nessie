import SwiftUI

struct MembersView: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var members: [JSONValue] = []
    @State private var invitations: [JSONValue] = []
    @State private var email = ""
    @State private var role = "member"
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false
    @State private var pending: MemberAction?

    var body: some View {
        List {
            if !loaded && error == nil { ProgressView("Loading people…") }
            Section("Team members") {
                ForEach(Array(members.enumerated()), id: \.offset) { _, member in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member["name"].string ?? member["email"].string ?? "Team member").font(.headline)
                            Text(
                                [member["team_role"].text.capitalized, member["email"].text]
                                    .filter { !$0.isEmpty }.joined(separator: " · ")
                            ).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if api.identity?.canManage == true, member["uoa_sub"].text != api.identity?.subject,
                            member["team_role"].text != "owner" {
                            Menu("Manage member", systemImage: "ellipsis.circle") {
                                Button(member["team_role"].text == "admin" ? "Make member" : "Make admin") {
                                    pending = MemberAction(member: member, operation: "role")
                                }
                                Button("Remove from team", role: .destructive) {
                                    pending = MemberAction(member: member, operation: "remove")
                                }
                            }
                        }
                    }
                }
            }
            if api.identity?.canManage == true {
                Section("Invite someone") {
                    TextField("Email address", text: $email).keyboardType(.emailAddress)
                        .textContentType(.emailAddress).textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Role", selection: $role) {
                        Text("Member").tag("member")
                        Text("Admin").tag("admin")
                    }
                    Button("Send invitation") { Task { await invite() } }.disabled(email.isEmpty || busy)
                }
                Section("Invitations") {
                    ForEach(Array(invitations.enumerated()), id: \.offset) { _, invitation in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(invitation["email"].text)
                            Text(invitation["status"].text.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let error {
                ErrorNotice(message: error)
                Button("Try again") { Task { await load() } }
            }
        }.navigationTitle("People").task { await load() }.refreshable { await load() }.disabled(busy)
            .confirmationDialog(
                "Update this team member?",
                isPresented: Binding(
                    get: { pending != nil }, set: { if !$0 { pending = nil } }
                )
            ) {
                if let pending {
                    Button("Confirm", role: pending.operation == "remove" ? .destructive : nil) {
                        Task { await update(pending) }
                    }
                }
            }
    }

    private func load() async {
        do {
            members = try await api.request("/v1/admin/workspace/members")["members"].array
            if api.identity?.canManage == true {
                invitations = try await api.request("/v1/admin/workspace/invitations")["invitations"].array
            }
            error = nil
            loaded = true
        } catch { self.error = error.localizedDescription }
    }
    private func invite() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.request(
                "/v1/admin/workspace/invitations", method: "POST",
                body: .object([
                    "invites": .array([.object(["email": .string(email), "teamRole": .string(role)])])
                ]))
            email = ""
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func update(_ action: MemberAction) async {
        busy = true
        defer { busy = false }
        let path =
            "/v1/admin/workspace/members/" + DeepWaterAPI.pathComponent(action.member["uoa_sub"].text)
        do {
            if action.operation == "remove" {
                _ = try await api.request(path, method: "DELETE")
            } else {
                let role = action.member["team_role"].text == "admin" ? "member" : "admin"
                _ = try await api.request(
                    path + "/role", method: "PUT", body: .object(["role": .string(role)]))
            }
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

private struct MemberAction {
    let member: JSONValue
    let operation: String
}
