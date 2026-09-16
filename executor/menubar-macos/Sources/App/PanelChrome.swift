import SwiftUI

/// The frame every panel shares: a title, the refusal line, and a body. One
/// component parameterised by its content rather than three panels that each
/// grew their own header and their own way of showing an error.
struct PanelChrome<Content: View>: View {
    @EnvironmentObject private var controller: ExecutorController
    let title: String
    let subtitle: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title2).bold()
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    content()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }

            if let refusal = controller.refusal {
                Divider()
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(refusal).font(.callout).textSelection(.enabled)
                    Spacer(minLength: 8)
                    Button("Dismiss") { controller.refusal = nil }
                }
                .padding(16)
                .background(.quaternary.opacity(0.4))
            }
        }
        .frame(minWidth: 480, minHeight: 380)
    }
}

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

/// The one thing to say when nothing is paired, on every panel, with the doorway
/// to the surface that fixes it.
struct UnpairedNotice: View {
    var body: some View {
        Label(
            "This Mac is not paired with Nessie yet. Open Settings from the menu bar icon and paste "
                + "the invitation from Agents → Executors.",
            systemImage: "link.badge.plus"
        )
        .font(.callout)
    }
}
