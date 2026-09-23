import SwiftUI

struct RunDetailView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.scenePhase) private var scenePhase
    let id: String
    let onOpen: (String) -> Void
    @State private var run: ResearchRun?
    @State private var sources: [JSONValue] = []
    @State private var events: [JSONValue] = []
    @State private var tab = "report"
    @State private var reportVersion = "full"
    @State private var error: String?
    @State private var action: String?
    @State private var busy = false
    @State private var extending: ResearchRun?

    var body: some View {
        Group {
            if let run {
                List {
                    Section {
                        Text(run.title).font(.title2.bold()).textSelection(.enabled)
                        Label(run.statusLabel, systemImage: run.isActive ? "circle.dotted" : "doc.text")
                            .foregroundStyle(run.color)
                        if run.isActive {
                            ProgressView()
                            Text("You can leave this screen. Your research will keep running.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if let failure = run.failure { ErrorNotice(message: failure) }
                    }
                    if let error {
                        Section {
                            ErrorNotice(message: error)
                            Button("Try again") { Task { await load() } }
                        }
                    }
                    Section {
                        Picker("Research details", selection: $tab) {
                            Text("Report").tag("report")
                            Text("Sources").tag("sources")
                            Text("Activity").tag("activity")
                        }.pickerStyle(.segmented).listRowInsets(EdgeInsets())
                    }.listRowBackground(Color.clear)
                    switch tab {
                    case "sources": sourceSection
                    case "activity": activitySection
                    default:
                        Section {
                            if !run.fullReport.isEmpty && !run.summary.isEmpty {
                                Picker("Read", selection: $reportVersion) {
                                    Text("Full report").tag("full")
                                    Text("Summary").tag("summary")
                                }
                            }
                            if run.report.isEmpty {
                                ContentUnavailableView(
                                    "Your report will appear here", systemImage: "doc.text",
                                    description: Text(
                                        run.isActive
                                            ? "DeepWater is working on your question."
                                            : "There is no report for this run yet."))
                            } else {
                                MarkdownReport(text: reportText(run), title: run.title)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .toolbar { detailToolbar(run) }
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn’t open research", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView("Opening research…")
            }
        }
        .navigationTitle("Research")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if run?.isActive == true && extending == nil { await load() }
            }
        }
        .confirmationDialog(
            actionTitle, isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } })
        ) {
            if let action {
                Button(actionLabel(action), role: action == "cancel" ? .destructive : nil) {
                    Task { await mutate(action) }
                }
            }
        } message: {
            Text(
                action == "publish"
                    ? "Anyone with the public report link will be able to read it."
                    : ["summary", "full_report"].contains(action ?? "")
                        ? "Generating a new report uses your team’s credits."
                        : "This changes the selected research run.")
        }
        .sheet(item: $extending) { source in
            ResearchComposer(projects: [], projectId: "", extending: source, onCreated: onOpen)
        }
    }

    @ToolbarContentBuilder private func detailToolbar(_ run: ResearchRun) -> some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if !run.report.isEmpty {
                ShareLink(item: reportText(run), subject: Text(run.title), preview: SharePreview(run.title))
                    .accessibilityIdentifier("shareReport")
            }
            Menu {
                if run.capabilities.contains("extend") {
                    Button("Ask a follow-up", systemImage: "plus.bubble") { extending = run }
                }
                ForEach(["pause", "resume", "restart", "summary", "full_report", "publish", "unpublish", "cancel"],
                        id: \.self) { name in
                    if run.capabilities.contains(name) {
                        Button(actionLabel(name), role: name == "cancel" ? .destructive : nil) { action = name }
                    }
                }
            } label: {
                Label("Research actions", systemImage: "ellipsis.circle")
            }.disabled(busy)
        }
    }

    private var sourceSection: some View {
        Section("\(sources.count) sources") {
            if sources.isEmpty {
                Text("Sources will appear as they are found.").foregroundStyle(.secondary)
            }
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                if let url = URL(string: source["url"].text), url.scheme == "http" || url.scheme == "https" {
                    Link(destination: url) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(source["title"].string ?? "Source \(index + 1)").font(.headline)
                            Text(url.host ?? url.absoluteString).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private var activitySection: some View {
        Section("Research activity") {
            if events.isEmpty { Text("No activity yet.").foregroundStyle(.secondary) }
            ForEach(Array(events.reversed().enumerated()), id: \.offset) { _, event in
                VStack(alignment: .leading, spacing: 4) {
                    Text(event["message"].string ?? event["phase"].string ?? event["kind"].text)
                    Text(event["at"].text).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func load() async {
        let key = DeepWaterAPI.pathComponent(id)
        do {
            async let detail = api.request("/v1/admin/runs/\(key)")
            async let sourceResult = api.request("/v1/research/\(key)/sources")
            async let activity = api.request("/v1/admin/runs/\(key)/events")
            let next = try await ResearchRun(detail)
            guard !Task.isCancelled else { return }
            run = next
            let nextSources = try await sourceResult["sources"].array
            let nextEvents = try await activity["events"].array
            guard !Task.isCancelled else { return }
            sources = nextSources
            events = nextEvents
            error = nil
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    private func mutate(_ action: String) async {
        busy = true
        defer { busy = false }
        let key = DeepWaterAPI.pathComponent(id)
        let path: String
        if ["summary", "full_report"].contains(action) {
            let operation = action == "summary" ? "generate-summary" : "generate-full-report"
            path = "/v1/research/\(key)/\(operation)"
        } else {
            let prefix = ["pause", "resume"].contains(action) ? "/v1/admin/research" : "/v1/admin/runs"
            path = "\(prefix)/\(key)/\(action)"
        }
        do {
            let result = try await api.request(path, method: "POST")
            if action == "restart", let next = result["id"].string { onOpen(next) }
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func reportText(_ run: ResearchRun) -> String {
        reportVersion == "summary" && !run.summary.isEmpty ? run.summary : run.report
    }

    private var actionTitle: String { action.map(actionLabel) ?? "Research" }
    private func actionLabel(_ value: String) -> String {
        switch value {
        case "summary": return "Generate summary"
        case "full_report": return "Generate full report"
        case "cancel": return "Cancel research"
        case "pause": return "Pause research"
        case "resume": return "Resume research"
        case "restart": return "Retry research"
        case "publish": return "Publish report"
        case "unpublish": return "Unpublish report"
        default: return value.capitalized
        }
    }
}
