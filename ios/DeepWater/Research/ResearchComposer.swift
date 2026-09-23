import SwiftUI

struct ResearchComposer: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    let projects: [Project]
    let projectId: String
    var extending: ResearchRun?
    let onCreated: (String) -> Void
    @State private var draft = ResearchDraft()
    @State private var busy = false
    @State private var error: String?
    @State private var canBePrivate: Bool?
    @State private var pending: ResearchLaunch?
    @State private var assistant = ResearchAssistant()
    @FocusState private var questionFocused: Bool

    private var title: String { extending == nil ? "New research" : "Ask a follow-up" }
    private var trimmedQuery: String { draft.query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canStart: Bool {
        !busy
            && (pending != nil
                || (!trimmedQuery.isEmpty && trimmedQuery.count <= 5_000
                    && (extending != nil
                        || (canBePrivate != nil && (draft.isPublic || canBePrivate == true)))))
    }

    var body: some View {
        NavigationStack {
            Form {
                if pending != nil {
                    Section {
                        Label("A launch is waiting to be confirmed", systemImage: "arrow.clockwise")
                        Text(
                            "Retry safely with your original question and settings."
                        )
                        .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    if let extending {
                        Text("Following up on “\(extending.title)”").font(.footnote).foregroundStyle(.secondary)
                    }
                    TextField(
                        extending == nil
                            ? "What would you like to understand?" : "What else would you like to explore?",
                        text: $draft.query, axis: .vertical
                    )
                    .lineLimit(4...10).focused($questionFocused).accessibilityIdentifier("researchQuestion")
                    if extending == nil {
                        NavigationLink {
                            ResearchAssistantView(assistant: assistant, draft: $draft)
                        } label: {
                            Label("Help me refine my question", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                } header: {
                    Text(extending == nil ? "Your question" : "Your follow-up")
                }
                .disabled(pending != nil)
                if !draft.pillars.isEmpty {
                    Section("Questions to explore") {
                        ForEach(Array(draft.pillars.enumerated()), id: \.offset) { _, pillar in Text(pillar) }
                        Button("Clear suggested questions") { draft.pillars = [] }
                    }.disabled(pending != nil)
                }
                Section {
                    Picker("Research depth", selection: $draft.depth) {
                        Text("Quick overview").tag("light")
                        Text("Balanced").tag("standard")
                        Text("Deep dive").tag("deep")
                        Text("Exhaustive").tag("heavy")
                    }
                    if extending == nil {
                        Picker("Project", selection: $draft.projectId) {
                            Text("No project").tag("")
                            ForEach(projects) { project in Text(project.title).tag(project.id) }
                        }
                    }
                } footer: {
                    Text("Greater depth explores more sources and uses more credits.")
                }
                .disabled(pending != nil)
                if extending == nil {
                    Section {
                        Toggle("Public report", isOn: $draft.isPublic)
                            .accessibilityIdentifier("publicReport")
                        if canBePrivate == false && !draft.isPublic {
                            Text(
                                "Choose public research, or change your plan in Account to keep it private."
                            )
                            .font(.footnote).foregroundStyle(.secondary)
                        }
                    } footer: {
                        Text(
                            draft.isPublic
                                ? "Your research may appear in the public archive and be reused as evidence."
                                : "Your research stays within the access rules for this team.")
                    }.disabled(pending != nil)
                    DisclosureGroup("Report options") { ReportOptions(draft: $draft) }.disabled(
                        pending != nil)
                }
                if let error { Section { ErrorNotice(message: error) } }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    questionFocused = false
                    Task { await start() }
                } label: {
                    HStack {
                        if busy { ProgressView() }
                        Text(pending != nil ? "Retry research launch" : "Start research")
                        Spacer()
                        Image(systemName: "arrow.right")
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!canStart).accessibilityIdentifier("startResearch")
                .padding().background(.bar)
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) }
            }
            .interactiveDismissDisabled(busy)
            .task { await prepare() }
        }
    }

    private func prepare() async {
        draft.projectId = projectId
        do {
            if let identity = api.identity, extending == nil {
                pending = try ResearchLaunchStore(identity: identity).read()
                if let pending { draft.query = pending.body["query"].text }
            }
            if extending != nil { return }
            let value = try await api.request("/v1/billing/account")
            guard case .bool(let allowed) = value["can_be_private"] else { throw ServiceError.invalidResponse }
            canBePrivate = allowed
        } catch { self.error = error.localizedDescription }
    }

    private func start() async {
        guard canStart, let identity = api.identity else { return }
        busy = true
        defer { busy = false }
        do {
            let result: JSONValue
            if let extending {
                result = try await api.request(
                    "/v1/admin/runs/\(DeepWaterAPI.pathComponent(extending.id))/extend",
                    method: "POST",
                    body: .object(["questions": .strings([trimmedQuery]), "depth": .string(draft.depth)]))
            } else {
                let launch = pending ?? ResearchLaunch(identity: identity, body: draft.body)
                guard launch.belongs(to: identity) else { throw CancellationError() }
                try ResearchLaunchStore(identity: identity).save(launch)
                pending = launch
                result = try await api.request(
                    "/v1/admin/research", method: "POST",
                    body: launch.body, idempotencyKey: launch.key)
            }
            guard let id = result["id"].string, UUID(uuidString: id) != nil else {
                throw ServiceError.invalidResponse
            }
            if extending == nil { try ResearchLaunchStore(identity: identity).clear() }
            onCreated(id)
            dismiss()
        } catch {
            if let service = error as? ServiceError, [400, 402, 403, 422].contains(service.status),
                extending == nil {
                do {
                    try ResearchLaunchStore(identity: identity).clear()
                    pending = nil
                } catch {
                    self.error = error.localizedDescription
                    return
                }
            }
            self.error = error.localizedDescription
        }
    }
}

private struct ReportOptions: View {
    @Binding var draft: ResearchDraft
    var body: some View {
        Picker("Language", selection: $draft.language) {
            ForEach(
                [
                    ("en", "English"), ("cs", "Czech"), ("de", "German"), ("fr", "French"),
                    ("es", "Spanish"), ("it", "Italian"), ("pt", "Portuguese"), ("ja", "Japanese"),
                    ("zh", "Chinese"), ("ar", "Arabic")
                ], id: \.0
            ) { code, name in Text(name).tag(code) }
        }
        Picker("Writing style", selection: $draft.style) {
            ForEach(
                ["standard", "plain", "scientific", "executive", "narrative", "explanatory"], id: \.self
            ) {
                Text($0.capitalized).tag($0)
            }
        }
        Picker("Report detail", selection: $draft.chapterDepth) {
            ForEach(["brief", "standard", "detailed", "exhaustive"], id: \.self) {
                Text($0.capitalized).tag($0)
            }
        }
        Picker("Search quality", selection: $draft.quality) {
            Text("Standard").tag("standard")
            Text("Premium").tag("premium")
        }
        Picker("Source recency", selection: $draft.recency) {
            Text("Any time").tag("any")
            Text("Past day").tag("day")
            Text("Past week").tag("week")
            Text("Past month").tag("month")
            Text("Past year").tag("year")
        }
    }
}
