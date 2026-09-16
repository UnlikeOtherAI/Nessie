import SwiftUI

/// A labelled fact with its value selectable. Paths and ids exist here to be
/// compared against what Nessie shows, which means they have to be copyable.
struct FactRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.body.monospaced()).textSelection(.enabled)
        }
    }
}

/// The sentence every mutating surface in this app ends with. A change here is a
/// *proposal*: the CLI writes a new local policy revision, `connect` submits it,
/// and it does nothing until an entitled person reviews it in Nessie.
struct PolicyReviewNote: View {
    let revision: Int

    var body: some View {
        Label(
            "Local policy is at revision \(revision). Saving a change writes revision \(revision + 1) "
                + "and submits it when the daemon next connects. It takes effect only after a person "
                + "reviews it in Nessie.",
            systemImage: "person.badge.shield.checkmark"
        )
        .font(.callout)
        .foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
    }
}

/// The one thing to say when nothing is paired, on every section, with the
/// doorway to the section that fixes it.
struct UnpairedNotice: View {
    @EnvironmentObject private var selection: ConsoleSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                "This Mac is not paired with Nessie yet. Paste the invitation from Agents → Executors "
                    + "in Nessie to pair it.",
                systemImage: "link.badge.plus"
            )
            .font(.callout)
            Button("Go to Settings") { selection.section = .settings }
        }
    }
}

/// The refusal a section shows when the packaged runtime could not be used. It
/// is the CLI's or the app's own wording, never a substitute.
struct UnavailableNotice: View {
    let reason: String

    var body: some View {
        Label(reason, systemImage: "exclamationmark.triangle.fill").font(.callout)
    }
}
