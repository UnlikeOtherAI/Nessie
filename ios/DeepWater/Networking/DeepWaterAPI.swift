import Foundation
import Observation

@MainActor @Observable
final class DeepWaterAPI {
    static let origin = "https://api.deepwater.live"
    static let webOrigin = "https://admin.deepwater.live"
    private(set) var identity: SessionIdentity?
    private(set) var restoring = true
    private(set) var generation = UUID()
    var sessionError: String?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var refreshTask: Task<Void, Error>?
    @ObservationIgnored let session: URLSession
    @ObservationIgnored private let vault = SessionVault()
    @ObservationIgnored private let testing: Bool

    init(testing: Bool = false) {
        self.testing = testing
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.urlCache = nil
        #if DEBUG
            if testing { configuration.protocolClasses = [FixtureTransport.self] }
        #endif
        session = URLSession(
            configuration: configuration, delegate: SameOriginRedirects(), delegateQueue: nil)
    }

    func restore() async {
        defer { restoring = false }
        do {
            if !testing {
                guard let data = try vault.read() else { return }
                let stored = try JSONDecoder().decode(StoredSession.self, from: data)
                guard stored.expires > Date(), let cookie = stored.cookie else {
                    try vault.clear()
                    return
                }
                session.configuration.httpCookieStorage?.setCookie(cookie)
            }
            try await refresh()
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func request(
        _ path: String, method: String = "GET", body: JSONValue? = nil,
        idempotencyKey: String? = nil
    ) async throws -> JSONValue {
        let current = generation
        do {
            let value = try await raw(path, method: method, body: body, idempotencyKey: idempotencyKey)
            guard generation == current else { throw CancellationError() }
            return value
        } catch let error as ServiceError where error.status == 401 && !path.hasPrefix("/v1/auth/") {
            try await refresh()
            guard generation == current else { throw CancellationError() }
            let value = try await raw(path, method: method, body: body, idempotencyKey: idempotencyKey)
            guard generation == current else { throw CancellationError() }
            return value
        }
    }

    func raw(
        _ path: String, method: String = "POST", body: JSONValue? = nil,
        idempotencyKey: String? = nil
    ) async throws -> JSONValue {
        guard path.hasPrefix("/v1/"), let url = URL(string: Self.origin + path),
            url.host == "api.deepwater.live"
        else { throw ServiceError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(Self.webOrigin, forHTTPHeaderField: "Origin")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body ?? .object([:]))
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
        if http.statusCode == 204 { return .null }
        let value = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(http.statusCode) else {
            throw ServiceError(
                status: http.statusCode,
                message: value["detail"].string
                    ?? value["message"].string ?? Self.message(for: http.statusCode))
        }
        guard value != .null else { throw ServiceError.invalidResponse }
        return value
    }

    func refresh() async throws {
        if let refreshTask { return try await refreshTask.value }
        let current = generation
        let task = Task { @MainActor in
            do {
                let value = try await raw("/v1/auth/refresh")
                guard generation == current else { throw CancellationError() }
                try accept(value)
            } catch let error as ServiceError where error.status == 401 {
                try clear()
                throw error
            }
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    func accept(_ value: JSONValue) throws {
        guard let accessToken = value["access_token"].string else { throw ServiceError.invalidResponse }
        let nextIdentity = try SessionIdentity(token: accessToken)
        if !testing,
            let cookie = session.configuration.httpCookieStorage?.cookies?.first(where: {
                $0.name == "dw_session"
                    && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
                        == "api.deepwater.live"
            }) {
            try vault.write(JSONEncoder().encode(StoredSession(cookie: cookie)))
        }
        if let identity,
            identity.subject != nextIdentity.subject || identity.organization != nextIdentity.organization
                || identity.team != nextIdentity.team {
            generation = UUID()
        }
        token = accessToken
        identity = nextIdentity
        sessionError = nil
    }

    func switchTeam(org: String, team: String) async throws {
        if let refreshTask { try await refreshTask.value }
        let value = try await raw(
            "/v1/auth/workspace", body: .object(["orgId": .string(org), "teamId": .string(team)]))
        guard let accessToken = value["access_token"].string else { throw ServiceError.invalidResponse }
        let next = try SessionIdentity(token: accessToken)
        guard next.subject == identity?.subject, next.organization == org, next.team == team else {
            try clear()
            throw ServiceError(status: 401, message: "Please sign in again to select that team.")
        }
        try accept(value)
        generation = UUID()
    }

    func signOut() async throws {
        if let refreshTask { try await refreshTask.value }
        _ = try await raw("/v1/auth/logout")
        try clear()
    }

    private func clear() throws {
        token = nil
        identity = nil
        generation = UUID()
        session.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        if !testing { try vault.clear() }
    }

    static func query(_ fields: [String: String]) -> String {
        var components = URLComponents()
        components.queryItems = fields.sorted { $0.key < $1.key }.map {
            URLQueryItem(name: $0.key, value: $0.value)
        }
        return components.percentEncodedQuery ?? ""
    }

    static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }

    private static func message(for status: Int) -> String {
        switch status {
        case 401: return "Your session has expired. Sign in again to continue."
        case 403: return "You don’t have access to this item."
        case 404: return "This item is no longer available."
        case 429: return "DeepWater is busy. Please try again shortly."
        default: return "DeepWater could not complete the request. Please try again."
        }
    }
}

private struct StoredSession: Codable {
    let value: String
    let expires: Date
    init(cookie: HTTPCookie) {
        value = cookie.value
        expires = cookie.expiresDate ?? Date()
    }
    var cookie: HTTPCookie? {
        HTTPCookie(properties: [
            .name: "dw_session", .value: value, .domain: "api.deepwater.live",
            .path: "/v1/auth", .secure: "TRUE", .expires: expires
        ])
    }
}

private final class SameOriginRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // API requests never follow redirects, keeping credentials on the original endpoint.
        completionHandler(nil)
    }
}
