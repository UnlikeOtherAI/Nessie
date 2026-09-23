import SwiftUI

struct LibraryView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.scenePhase) private var scenePhase
    @State private var runs: [ResearchRun] = []
    @State private var projects: [Project] = []
    @State private var selected: String?
    @State private var projectId = ""
    @State private var search = ""
    @State private var filter = "all"
    @State private var total = 0
    @State private var loading = false
    @State private var error: String?
    @State private var sheet: LibrarySheet?
    @State private var requestId = UUID()
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    private var title: String { projects.first { $0.id == projectId }?.title ?? "Research" }
    private var queryKey: String { "\(search)|\(projectId)|\(filter)" }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: $selected) {
                Section {
                    Picker("Show research", selection: $filter) {
                        Text("All").tag("all")
                        Text("Attention").tag("failed")
                        Text("Reports").tag("complete")
                    }.pickerStyle(.segmented).listRowInsets(EdgeInsets())
                }.listRowBackground(Color.clear)
                if let error {
                    Section {
                        ErrorNotice(message: error)
                        Button("Try again") { Task { await load() } }
                    }
                }
                ForEach(runs) { run in
                    NavigationLink(value: run.id) { RunRow(run: run) }
                        .accessibilityIdentifier("run-\(run.id)")
                }
                if runs.count < total {
                    Button("Load more research") { Task { await load(append: true) } }.disabled(loading)
                }
                if loading { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            }
            .overlay {
                if runs.isEmpty && !loading && error == nil {
                    ContentUnavailableView {
                        Label(
                            search.isEmpty ? "Your next discovery starts here" : "No matching research",
                            systemImage: search.isEmpty ? "text.book.closed" : "magnifyingglass")
                    } description: {
                        Text(
                            search.isEmpty
                                ? "Ask a question. DeepWater will find and check the evidence."
                                : "Try another search.")
                    } actions: {
                        if search.isEmpty {
                            Button("New research") { sheet = .compose }.buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 440)
            .searchable(text: $search, prompt: "Search your research")
            .refreshable { await load() }
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    Button("Account", systemImage: "person.crop.circle") { sheet = .account }
                        .accessibilityIdentifier("account")
                    Button("Updates", systemImage: "bell") { sheet = .updates }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("Projects", systemImage: "folder") { sheet = .projects }
                        .accessibilityIdentifier("projects")
                    Button("New research", systemImage: "square.and.pencil") { sheet = .compose }
                        .keyboardShortcut("n", modifiers: .command).accessibilityIdentifier("newResearch")
                }
            }
        } detail: {
            if let selected {
                RunDetailView(id: selected) { id in
                    self.selected = id
                    Task { await load() }
                }.id(selected)
            } else {
                ContentUnavailableView(
                    "Make room for a better answer", systemImage: "doc.text.magnifyingglass",
                    description: Text("Choose research to read its report, sources, and progress."))
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(item: $sheet) { destination in
            switch destination {
            case .compose:
                ResearchComposer(projects: projects, projectId: projectId) { id in
                    selected = id
                    Task { await load() }
                }
            case .account: AccountView()
            case .updates: ResearchInboxView { selected = $0 }
            case .projects:
                ProjectsView(selected: $projectId, projects: $projects)
            }
        }
        .task(id: queryKey) {
            do { try await Task.sleep(for: .milliseconds(search.isEmpty ? 0 : 250)) } catch { return }
            await load()
        }
        .task {
            do {
                var all: [Project] = []
                var total = 0
                repeat {
                    let path = "/v1/admin/projects?limit=100&offset=\(all.count)"
                    let value = try await api.request(path)
                    let page = try value["projects"].array.map(Project.init)
                    total = value["total"].int
                    guard !page.isEmpty || all.count >= total else { throw ServiceError.invalidResponse }
                    all += page
                } while all.count < total && !Task.isCancelled
                projects = all
                if let identity = api.identity, try ResearchLaunchStore(identity: identity).read() != nil {
                    sheet = .compose
                }
            } catch { self.error = error.localizedDescription }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                if runs.contains(where: \.isActive) && sheet == nil { await load() }
            }
        }
    }

    private func load(append: Bool = false) async {
        let request = UUID()
        requestId = request
        loading = true
        defer { if requestId == request { loading = false } }
        var fields = ["limit": "50", "offset": String(append ? runs.count : 0), "order": "activity"]
        if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fields["q"] = String(search.prefix(200))
        }
        if !projectId.isEmpty { fields["project_id"] = projectId }
        if filter != "all" { fields["status"] = filter }
        do {
            let value = try await api.request("/v1/admin/runs?" + DeepWaterAPI.query(fields))
            let next = try value["runs"].array.map(ResearchRun.init)
            guard requestId == request, !Task.isCancelled else { return }
            runs = append ? runs + next.filter { run in !runs.contains { $0.id == run.id } } : next
            total = value["total"].int
            error = nil
        } catch is CancellationError {} catch {
            guard requestId == request else { return }
            self.error = error.localizedDescription
        }
    }
}

private enum LibrarySheet: String, Identifiable {
    case compose, projects, account, updates
    var id: String { rawValue }
}

struct RunRow: View {
    let run: ResearchRun
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(run.title).font(.headline).lineLimit(3)
            HStack {
                Label(
                    run.statusLabel,
                    systemImage: run.status == "complete" && !run.isActive ? "checkmark.circle" : "circle.dotted"
                )
                .foregroundStyle(run.color)
                Spacer(minLength: 4)
                if run.sourceCount > 0 { Text("\(run.sourceCount) sources").foregroundStyle(.secondary) }
            }.font(.caption)
        }.padding(.vertical, 7)
    }
}

struct ProjectsView: View {
    @Environment(DeepWaterAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: String
    @Binding var projects: [Project]
    @State private var name = ""
    @State private var error: String?
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                Button {
                    selected = ""
                    dismiss()
                } label: {
                    Label("All research", systemImage: "tray.full")
                }
                Section("Projects") {
                    ForEach(projects) { project in
                        Button {
                            selected = project.id
                            dismiss()
                        } label: {
                            HStack {
                                Label(project.title, systemImage: "folder")
                                Spacer()
                                if selected == project.id { Image(systemName: "checkmark") }
                            }
                        }
                    }
                }
                Section("New project") {
                    TextField("Project name", text: $name).accessibilityIdentifier("projectName")
                    Button("Create project") { Task { await create() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || creating)
                    if let error { ErrorNotice(message: error) }
                }
            }.navigationTitle("Projects")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            let value = try await api.request(
                "/v1/admin/projects", method: "POST",
                body: .object([
                    "title": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))
                ]))
            let project = try Project(value)
            projects.insert(project, at: 0)
            selected = project.id
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
