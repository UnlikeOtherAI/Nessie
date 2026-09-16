import SwiftUI

/// Tools it can run: the permitted programs of the reviewed local policy.
///
/// Adding or removing one is a policy revision, exactly like enabling an
/// operation — the section says so before the change and the CLI enforces it.
/// The app never edits the list itself; it hands the whole list to `configure`.
struct ToolsSection: View {
    @EnvironmentObject private var controller: ExecutorController
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch controller.model.pairing {
            case let .unavailable(reason):
                UnavailableNotice(reason: reason)
            case .unpaired:
                UnpairedNotice()
            case let .paired(description):
                list(description)
                Divider()
                addField(description)
                Divider()
                PolicyReviewNote(revision: description.policy.revision)
                Text(
                    description.commandRunEnabled
                        ? "command.run is enabled for this executor, so the list must always name at "
                            + "least one program: an operation that can never succeed is a "
                            + "misconfiguration, not a policy."
                        : "command.run is not enabled for this executor. These programs take effect when "
                            + "somebody enables it in Nessie."
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            }
        }
    }

    /// Entries are rendered as the policy states them, never re-derived. That is
    /// what lets a wildcard entry — a form the policy is gaining — appear here
    /// correctly the moment the CLI accepts one, with no change to this view.
    private func list(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Permitted programs").font(.headline)
            if description.policy.permittedPrograms.isEmpty {
                Text("No program is permitted, so no command may start.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(description.policy.permittedPrograms, id: \.self) { program in
                HStack {
                    Image(systemName: "terminal")
                    Text(program).font(.body.monospaced()).textSelection(.enabled)
                    Spacer()
                    Button("Remove") { remove(program, from: description) }
                        .disabled(controller.busy)
                }
                .padding(.vertical, 1)
            }
        }
    }

    private func addField(_ description: ExecutorDescription) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Add a program").font(.headline)
            HStack {
                TextField("git", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .onSubmit { add(to: description) }
                Button("Add") { add(to: description) }
                    .disabled(controller.busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Text(PermittedProgram.grammarRefusal)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func add(to description: ExecutorDescription) {
        switch PermittedProgram.validate(adding: draft, to: description.policy.permittedPrograms) {
        case let .failure(refusal):
            controller.refusal = refusal.message
        case let .success(programs):
            draft = ""
            controller.proposePolicy(commandAllowlist: programs)
        }
    }

    private func remove(_ program: String, from description: ExecutorDescription) {
        switch PermittedProgram.validate(
            removing: program,
            from: description.policy.permittedPrograms,
            commandRunEnabled: description.commandRunEnabled
        ) {
        case let .failure(refusal):
            controller.refusal = refusal.message
        case let .success(programs):
            controller.proposePolicy(commandAllowlist: programs)
        }
    }
}
