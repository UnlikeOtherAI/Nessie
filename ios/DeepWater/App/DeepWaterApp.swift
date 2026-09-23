import SwiftUI

@main
struct DeepWaterApp: App {
    @State private var api: DeepWaterAPI

    init() {
        #if DEBUG
            _api = State(
                initialValue: DeepWaterAPI(
                    testing: ProcessInfo.processInfo.arguments.contains("--ui-testing")))
        #else
            _api = State(initialValue: DeepWaterAPI())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if api.restoring {
                    ProgressView("Opening DeepWater…")
                } else if api.identity != nil {
                    LibraryView().id(api.generation)
                } else {
                    SignInView()
                }
            }
            .environment(api)
            .tint(Brand.accent)
            .task { await api.restore() }
        }
    }
}

enum Brand {
    // DeepWater's web design tokens; native materials and semantic labels remain system-owned.
    static let accent = Color(red: 0, green: 113 / 255, blue: 227 / 255)
}

struct SignInView: View {
    @Environment(DeepWaterAPI.self) private var api
    @State private var oauth = OAuthSignIn()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image("BrandMark").resizable().scaledToFit().frame(width: 76, height: 76)
                        .accessibilityHidden(true)
                    Text("DeepWater").font(.largeTitle.bold())
                    Text("A question. A clearer picture.").font(.title2)
                    Text("Explore a topic, follow the evidence, and keep your research together.")
                        .foregroundStyle(.secondary)
                    Button {
                        Task { await oauth.signIn(api: api) }
                    } label: {
                        HStack {
                            if oauth.busy { ProgressView() }
                            Text(oauth.busy ? "Signing in…" : "Continue with UnlikeOtherAI")
                        }.frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(oauth.busy)
                    .accessibilityIdentifier("signIn")
                    Text("Use the same account and team as DeepWater on the web.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let error = oauth.error ?? api.sessionError { ErrorNotice(message: error) }
                }
                .frame(maxWidth: 420, alignment: .leading).padding(32)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center)
        }
    }
}

struct ErrorNotice: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.callout).foregroundStyle(.red).accessibilityIdentifier("errorNotice")
    }
}
