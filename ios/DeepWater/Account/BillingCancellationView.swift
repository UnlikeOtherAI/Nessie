import SwiftUI

struct BillingCancellationView: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var preview: JSONValue = .null
    @State private var confirmation: JSONValue = .null
    @State private var selection = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            if confirmation != .null {
                Section {
                    Label(confirmation["title"].text, systemImage: "checkmark.circle")
                    Text(confirmation["message"].text)
                }
            } else if preview != .null {
                Section {
                    Text(preview["title"].text).font(.headline)
                    Text(preview["message"].text)
                }
                if preview["choice_required"].bool {
                    Section("Choose what to cancel") {
                        ForEach(Array(preview["choices"].array.enumerated()), id: \.offset) { _, choice in
                            Button { selection = choice["id"].text } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(choice["label"].text)
                                        Text(choice["description"].text).font(.footnote).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if selection == choice["id"].text { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    }
                }
                Section("Subscriptions affected") {
                    ForEach(Array(preview["direct_services"].array.enumerated()), id: \.offset) { _, service in
                        LabeledContent(service["display_name"].text,
                                       value: "\(service["direct_user_count"].int) direct users")
                    }
                }
                Section {
                    ForEach(Array(preview["indirect_services"].array.enumerated()), id: \.offset) { _, service in
                        LabeledContent(service["display_name"].text, value: service["impact"].text)
                    }
                    Button(preview["confirm_action"]["label"].text, role: .destructive) {
                        Task { await confirm() }
                    }.disabled(busy || (preview["confirm_action"]["selection_required"].bool && selection.isEmpty))
                }
            } else if error == nil { ProgressView("Checking the impact…") }
            if let error { ErrorNotice(message: error) }
        }.navigationTitle("Cancel plan").navigationBarTitleDisplayMode(.inline)
            .task {
                do {
                    preview = try await api.request("/v1/billing/cancellation/preview", method: "POST")
                    selection = preview["confirm_action"]["default_selection"].text
                } catch { self.error = error.localizedDescription }
            }
    }

    private func confirm() async {
        busy = true
        defer { busy = false }
        do {
            guard !preview["preview_token"].text.isEmpty,
                  !preview["confirm_action"]["idempotency_key"].text.isEmpty else {
                throw ServiceError.invalidResponse
            }
            confirmation = try await api.request("/v1/billing/cancellation/confirm", method: "POST", body: .object([
                "preview_token": preview["preview_token"],
                "idempotency_key": preview["confirm_action"]["idempotency_key"],
                "selection": selection.isEmpty ? .null : .string(selection)
            ]))
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
