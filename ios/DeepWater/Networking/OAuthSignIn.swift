import AuthenticationServices
import Foundation
import Observation
import Security

@MainActor @Observable
final class OAuthSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    var busy = false
    var error: String?
    @ObservationIgnored private var browser: ASWebAuthenticationSession?

    func signIn(api: DeepWaterAPI) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer {
            busy = false
            browser = nil
        }
        do {
            let response = try await api.raw("/v1/auth/start")
            guard let address = response["authorization_url"].string,
                var components = URLComponents(string: address),
                components.scheme == "https", components.host == "authentication.unlikeotherai.com",
                let redirect = components.queryItems?.first(where: { $0.name == "redirect_url" })?.value,
                redirect == Self.callback
            else { throw ServiceError.invalidResponse }
            let state = try Self.randomState()
            components.queryItems =
                (components.queryItems ?? []).filter { $0.name != "state" }
                + [URLQueryItem(name: "state", value: state)]
            guard let url = components.url else { throw ServiceError.invalidResponse }
            let callback = try await authenticate(url)
            let code = try Self.validate(callback, state: state)
            let result = try await api.raw(
                "/v1/auth/exchange",
                body: .object([
                    "code": .string(code), "redirect_url": .string(Self.callback)
                ]))
            try api.accept(result)
        } catch let authError as ASWebAuthenticationSessionError where authError.code == .canceledLogin {
            // Cancellation is a normal exit, not a failed login.
        } catch { self.error = error.localizedDescription }
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callback: .https(host: "admin.deepwater.live", path: "/auth/callback")
            ) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    continuation.resume(throwing: error ?? ServiceError.invalidResponse)
                }
            }
            session.presentationContextProvider = self
            browser = session
            guard session.start() else {
                continuation.resume(
                    throwing: ServiceError(status: 0, message: "Sign-in could not open. Please try again."))
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    static let callback = "https://admin.deepwater.live/auth/callback"

    static func validate(_ url: URL, state: String) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme == "https", components.host == "admin.deepwater.live",
            components.port == nil, components.user == nil, components.password == nil,
            components.path == "/auth/callback", components.fragment == nil
        else {
            throw ServiceError(
                status: 401, message: "The sign-in response was not recognized. Please try again.")
        }
        let items = components.queryItems ?? []
        let states = items.filter { $0.name == "state" }
        let codes = items.filter { $0.name == "code" }
        guard states.count == 1, states.first?.value == state,
            !items.contains(where: { $0.name == "error" }),
            codes.count == 1, let code = codes.first?.value, !code.isEmpty
        else {
            throw ServiceError(status: 401, message: "Sign-in expired or was declined. Please try again.")
        }
        return code
    }

    private static func randomState() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ServiceError.invalidResponse
        }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
