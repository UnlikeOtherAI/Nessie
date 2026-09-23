import SwiftUI

struct BillingView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.openURL) private var openURL
    @State private var statement: JSONValue = .null
    @State private var credits: JSONValue = .null
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Form {
            if statement == .null && error == nil { ProgressView("Loading your plan…") }
            if statement != .null {
                Section("Your plan") {
                    Text(statement["plan"]["display_name"].text).font(.headline)
                    if let status = statement["subscription"]["display_status"].string { Text(status) }
                    Text(statement["plan"]["monthly_subscription"]["display"].text)
                }
                Section("Credits") {
                    LabeledContent("Remaining credits", value: credits["credit_balance"]["display"].text)
                    Text(credits["credit_balance"]["description"].text).font(.footnote).foregroundStyle(
                        .secondary)
                }
                if credits["capabilities"]["can_top_up"].bool {
                    Section(credits["funding_policy"]["title"].text) {
                        ForEach(Array(credits["funding_policy"]["offers"].array.enumerated()),
                                id: \.offset) { _, offer in
                            Button {
                                Task { await topUp(offer["id"].text) }
                            } label: {
                                LabeledContent(offer["credits_received"]["display"].text,
                                               value: offer["payment_amount"]["display"].text)
                            }.disabled(!offer["available"].bool || !offer["action"]["enabled"].bool || busy)
                        }
                    }
                }
                Section("This month") {
                    ForEach(Array(statement["commercial_lines"].array.enumerated()), id: \.offset) { _, line in
                        LabeledContent(line["label"].text, value: line["amount"]["display"].text)
                    }
                    ForEach(Array(statement["totals"].array.enumerated()), id: \.offset) { _, total in
                        LabeledContent("Total due", value: total["total_due"]["display"].text).font(.headline)
                    }
                }
                Section {
                    ForEach(Array(statement["actions"].array.enumerated()), id: \.offset) { _, action in
                        if action["id"].text == "cancel" {
                            NavigationLink(action["label"].text) { BillingCancellationView() }
                                .disabled(!action["enabled"].bool || busy)
                        } else if ["portal", "upgrade"].contains(action["id"].text) {
                            Button(action["label"].text) { Task { await perform(action["id"].text) } }
                                .disabled(!action["enabled"].bool || busy)
                            if let reason = action["disabled_reason"].string {
                                Text(reason).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Account and payment changes open the secure billing service.")
                }
            }
            if let error {
                ErrorNotice(message: error)
                Button("Try again") { Task { await load() } }
            }
        }.navigationTitle("Plan and credits").task { await load() }.refreshable { await load() }
    }

    private func load() async {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        do {
            async let nextStatement = api.request(
                "/v1/billing/statement?month=" + formatter.string(from: Date()))
            async let nextCredits = api.request("/v1/billing/credits")
            statement = try await nextStatement
            credits = try await nextCredits
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func topUp(_ offerId: String) async {
        busy = true
        defer { busy = false }
        do {
            let value = try await api.request("/v1/billing/credits/top-up", method: "POST",
                                               body: .object(["offer_id": .string(offerId)]))
            try openHosted(value)
        } catch { self.error = error.localizedDescription }
    }

    private func openHosted(_ value: JSONValue) throws {
        guard let url = URL(string: value["redirect_url"].text), url.scheme == "https", url.user == nil else {
            throw ServiceError.invalidResponse
        }
        openURL(url)
    }

    private func perform(_ action: String) async {
        guard ["portal", "upgrade"].contains(action) else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await api.request("/v1/billing/actions/\(action)", method: "POST")
            try openHosted(value)
        } catch { self.error = error.localizedDescription }
    }
}
