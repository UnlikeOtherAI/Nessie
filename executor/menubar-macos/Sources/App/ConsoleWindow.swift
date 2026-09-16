import AppKit
import SwiftUI

/// The one window. Three sections behind one selector, and the window sizes
/// itself to whichever section is showing.
///
/// `sizingOptions = .preferredContentSize` is what does the sizing: SwiftUI
/// reports the root view's ideal height and AppKit makes the window that tall.
/// Without it the window kept whatever height it was created with, which is how
/// the short sections ended up with a field of empty white below them.
@MainActor
final class ConsoleWindowController: NSObject, NSWindowDelegate {
    private let controller: ExecutorController
    private let selection: ConsoleSelection
    private var window: NSWindow?

    init(controller: ExecutorController) {
        self.controller = controller
        self.selection = ConsoleSelection()
    }

    func show(_ section: ConsoleSection) {
        controller.refresh()
        selection.section = section
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let hosting = NSHostingController(
            rootView: ConsoleView()
                .environmentObject(controller)
                .environmentObject(selection)
        )
        hosting.sizingOptions = [.preferredContentSize]
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.title = "Nessie Executor"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
    }
}

/// Which section is showing. It outlives the window so reopening the app lands
/// a person back where they were, and the status menu writes to it directly.
@MainActor
final class ConsoleSelection: ObservableObject {
    @Published var section: ConsoleSection = .settings
}

struct ConsoleView: View {
    @EnvironmentObject private var controller: ExecutorController
    @EnvironmentObject private var selection: ConsoleSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            section
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            if let failure = controller.failure {
                Divider()
                FailureBanner(failure: failure)
            }
        }
        // A fixed width, because a window that changed width as a person moved
        // between three sections would be the thing they noticed instead of the
        // content. Only the height follows the section.
        .frame(width: 560, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The selector. A segmented control, so the current section is visibly
    /// selected and the other two are visibly available — the question "how do I
    /// get to the other screens?" is answered by the control itself.
    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("", selection: $selection.section) {
                ForEach(ConsoleSection.allCases) { candidate in
                    Label(candidate.title, systemImage: candidate.symbolName).tag(candidate)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            VStack(alignment: .leading, spacing: 3) {
                Text(selection.section.title).font(.title3).bold()
                Text(selection.section.subtitle).font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(20)
    }

    @ViewBuilder
    private var section: some View {
        switch selection.section {
        case .settings: SettingsSection()
        case .reach: ReachSection()
        case .tools: ToolsSection()
        }
    }

}

/// What a person reads when something failed.
///
/// The headline is what happened in their terms and the button does the thing
/// that fixes it. The API's own sentence is kept underneath, because it is what
/// somebody would quote in a support conversation — but it is never the whole
/// of the message, which is what "Executor descriptor revisions cannot move
/// backwards." with a lone Dismiss button was.
struct FailureBanner: View {
    @EnvironmentObject private var controller: ExecutorController
    let failure: ExecutorFailure
    @State private var showingDetail = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 8) {
                Text(failure.explanation).font(.callout).textSelection(.enabled)
                if showingDetail {
                    Text(failure.detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                HStack(spacing: 10) {
                    if let title = failure.remedyTitle {
                        Button(title) { controller.apply(failure.remedy) }
                            .keyboardShortcut(.defaultAction)
                            .disabled(controller.busy)
                    }
                    Button("Dismiss") { controller.failure = nil }
                    Spacer(minLength: 0)
                    Button(showingDetail ? "Hide details" : "Details") {
                        showingDetail.toggle()
                    }
                    .buttonStyle(.link)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4))
    }
}
