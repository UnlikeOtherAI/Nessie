import Foundation

/// The voice-scoped device credential, as the phone holds it.
///
/// In memory only, for the length of one call. It is deliberately not
/// persisted: the WebView mints a fresh one on every call, so a stored copy
/// would be a credential nothing ever reads. Phase 3 — the assistant placing
/// the call — is where a durable one starts to matter, because there is no
/// WebView in that path to mint from.
struct VoiceDeviceCredential {
    let token: String
    let expiresAt: Date
    let refreshAfter: Date
    let installationId: String
    let apiBaseUrl: String
}

enum NessieVoiceApiError: LocalizedError {
    case notProvisioned
    case http(status: Int, code: String?, message: String?)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .notProvisioned:
            return "Sign in to Nessie on this phone before calling your assistant."
        case .http(let status, let code, let message):
            if let message, !message.isEmpty { return message }
            return "The call service refused the request (\(code ?? "HTTP \(status)"))."
        case .malformedResponse:
            return "The call service answered in a shape this app does not understand."
        }
    }

    /// A credential this device can never fix by retrying.
    var isCredentialDead: Bool {
        if case .http(let status, let code, _) = self {
            return status == 401 || code == "VOICE_CREDENTIAL_OUT_OF_SCOPE"
        }
        return false
    }
}

/// The Nessie half of a native call: everything except the audio, which goes
/// straight to Google.
///
/// Every request carries the voice-scoped device credential as a bearer token.
/// That credential is accepted on the enumerated voice routes and refused with
/// `403 VOICE_CREDENTIAL_OUT_OF_SCOPE` anywhere else, so this file is also the
/// complete list of what a phone on a locked screen can reach.
actor NessieVoiceApi {
    private var credential: VoiceDeviceCredential
    private let session: URLSession
    private var refreshTask: Task<VoiceDeviceCredential, Error>?

    init(credential: VoiceDeviceCredential) {
        self.credential = credential
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 20
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    var installationId: String { credential.installationId }

    // MARK: - Calls

    func startSession() async throws -> VoiceSessionCredential {
        try await post(
            path: "/api/voice/sessions",
            body: ["installationId": credential.installationId]
        )
    }

    func rotateSession(_ voiceSessionId: String) async throws -> VoiceSessionRotation {
        try await post(path: "/api/voice/sessions/\(voiceSessionId)/rotate", body: [:])
    }

    func reportUsage(
        voiceSessionId: String,
        sequence: Int,
        model: String,
        usage: [String: Any]?,
        complete: Bool
    ) async throws {
        var body: [String: Any] = ["sequence": sequence, "model": model]
        body["usage"] = usage ?? NSNull()
        if complete { body["complete"] = true }
        _ = try await postRaw(path: "/api/voice/sessions/\(voiceSessionId)/usage", body: body)
    }

    func runTool(
        voiceSessionId: String,
        providerCallId: String,
        name: String,
        args: [String: Any]
    ) async throws -> VoiceToolCallResult {
        try await post(
            path: "/api/voice/sessions/\(voiceSessionId)/tool-call",
            body: ["providerCallId": providerCallId, "name": name, "args": args]
        )
    }

    /// Hands a request to the assistant's own longer-running self.
    ///
    /// A voice-scoped route rather than the generic message route: the device
    /// credential is deliberately not accepted there, and widening that route's
    /// auth would bolt a second mode onto every general route in the API.
    func sendToAssistant(
        voiceSessionId: String,
        text: String
    ) async throws -> VoiceSendToAssistantResponse {
        try await post(
            path: "/api/voice/sessions/\(voiceSessionId)/pa-send",
            body: ["text": text]
        )
    }

    func repliesAfter(
        voiceSessionId: String,
        messageId: String
    ) async throws -> VoiceAssistantRepliesResponse {
        let escaped = messageId.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? messageId
        return try await get(
            path: "/api/voice/sessions/\(voiceSessionId)/replies?after=\(escaped)"
        )
    }

    func submitTranscript(
        voiceSessionId: String,
        lines: [VoiceTranscriptLine],
        durationMs: Int
    ) async throws {
        let encoded = try JSONEncoder().encode(lines)
        let payload = try JSONSerialization.jsonObject(with: encoded)
        _ = try await postRaw(
            path: "/api/voice/sessions/\(voiceSessionId)/transcript",
            body: ["lines": payload, "durationMs": durationMs]
        )
    }

    func endSession(_ voiceSessionId: String) async throws {
        _ = try await postRaw(path: "/api/voice/sessions/\(voiceSessionId)/end", body: [:])
    }

    // MARK: - The device credential

    /// Renews the credential if it is due, coalescing concurrent callers.
    ///
    /// The native side owns this, not the WebView: a locked-phone call outlives
    /// any foreground refresh, and rotation, usage and the transcript all need
    /// a live credential mid-call.
    func refreshIfDue() async {
        guard Date() >= credential.refreshAfter else { return }
        _ = try? await refreshCredential()
    }

    @discardableResult
    private func refreshCredential() async throws -> VoiceDeviceCredential {
        if let refreshTask { return try await refreshTask.value }
        let task = Task { () throws -> VoiceDeviceCredential in
            let response: VoiceDeviceTokenResponse = try await send(
                request: try request(method: "POST", path: "/api/voice/device-token/refresh", body: [:])
            )
            let renewed = VoiceDeviceCredential(
                token: response.token,
                expiresAt: VoiceDate.parse(response.expiresAt) ?? Date().addingTimeInterval(3_600),
                refreshAfter: VoiceDate.parse(response.refreshAfter) ?? Date().addingTimeInterval(1_800),
                installationId: response.installationId,
                apiBaseUrl: credential.apiBaseUrl
            )
            // The predecessor is revoked server-side under a conditional
            // update, so from here the old token is dead and only this one
            // works.
            credential = renewed
            return renewed
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    // MARK: - Transport

    private func get<T: Decodable>(path: String) async throws -> T {
        await refreshIfDue()
        return try await sendRetrying(method: "GET", path: path, body: nil)
    }

    private func post<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        await refreshIfDue()
        return try await sendRetrying(method: "POST", path: path, body: body)
    }

    @discardableResult
    private func postRaw(path: String, body: [String: Any]) async throws -> Data {
        await refreshIfDue()
        do {
            return try await sendData(request: try request(method: "POST", path: path, body: body))
        } catch let error as NessieVoiceApiError where error.isCredentialDead {
            _ = try await refreshCredential()
            return try await sendData(request: try request(method: "POST", path: path, body: body))
        }
    }

    /// One retry behind a credential refresh.
    ///
    /// A 401 mid-call is nearly always a credential that aged out between the
    /// `refreshAfter` check and the request; anything else it could be (the
    /// session signed out, the member deactivated, the device revoked) fails
    /// the retry too and ends the call with a real reason.
    private func sendRetrying<T: Decodable>(
        method: String,
        path: String,
        body: [String: Any]?
    ) async throws -> T {
        do {
            return try await send(request: try request(method: method, path: path, body: body))
        } catch let error as NessieVoiceApiError where error.isCredentialDead {
            _ = try await refreshCredential()
            return try await send(request: try request(method: method, path: path, body: body))
        }
    }

    private func request(method: String, path: String, body: [String: Any]?) throws -> URLRequest {
        guard let url = URL(string: credential.apiBaseUrl + path) else {
            throw NessieVoiceApiError.notProvisioned
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func send<T: Decodable>(request: URLRequest) async throws -> T {
        let data = try await sendData(request: request)
        guard let envelope = try? JSONDecoder().decode(ApiEnvelope<T>.self, from: data) else {
            throw NessieVoiceApiError.malformedResponse
        }
        return envelope.data
    }

    private func sendData(request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NessieVoiceApiError.malformedResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let detail = error?["error"] as? [String: Any]
            throw NessieVoiceApiError.http(
                status: http.statusCode,
                code: detail?["code"] as? String,
                message: detail?["message"] as? String
            )
        }
        return data
    }
}

/// One ISO-8601 parser, tolerating both of the shapes the API emits.
enum VoiceDate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
