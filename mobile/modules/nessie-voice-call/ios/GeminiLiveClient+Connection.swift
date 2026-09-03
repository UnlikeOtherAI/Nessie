import Foundation

extension GeminiLiveClient {
    @discardableResult
    func connectWebSocket(accessToken: String) -> Bool {
        messageStateLock.lock()
        guard !isStopping else {
            messageStateLock.unlock()
            return false
        }
        let previousTask = socketTask
        let previousSession = urlSession
        isSocketOpen = false
        isReadyForRealtimeInput = false

        // The credential travels in the query string, not a header. Google's
        // constrained endpoint wants `access_token`, and refuses `key` with a
        // 1007 close naming `CreateAuthToken` — a distinction only the live
        // service ever shows, and the one this repo's browser client already
        // paid for. Native could set a header instead; keeping one form means
        // one contract across both clients.
        guard let base = URL(string: websocketUrl),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            messageStateLock.unlock()
            return false
        }
        components.queryItems = [URLQueryItem(name: "access_token", value: accessToken)]
        guard let url = components.url else {
            messageStateLock.unlock()
            return false
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        self.urlSession = session
        self.socketTask = task
        messageStateLock.unlock()
        task.resume()

        previousTask?.cancel(with: .goingAway, reason: nil)
        previousSession?.invalidateAndCancel()
        receiveLoop(task)
        emitStatus("Connecting to the voice service")
        return true
    }

    func receiveLoop(_ task: URLSessionWebSocketTask) {
        guard socketTask === task else { return }
        task.receive { [weak self, weak task] result in
            guard let self, let task else { return }
            self.messageStateLock.lock()
            guard self.socketTask === task else {
                self.messageStateLock.unlock()
                return
            }
            var shouldContinueReceiving = false
            switch result {
            case .failure(let error):
                self.isSocketOpen = false
                self.isReadyForRealtimeInput = false
                if self.isRotatingCredential {
                    self.messageStateLock.unlock()
                    return
                }
                if !self.scheduleReconnect(reason: error.localizedDescription) {
                    self.finishAfterConnectionLoss("The call dropped: \(error.localizedDescription)")
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    // Gemini answers in binary frames. `URLSessionWebSocketTask`
                    // hands them over as `.data`, so decoding here is what the
                    // browser client needs `binaryType = 'arraybuffer'` for.
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                shouldContinueReceiving = true
            }
            self.messageStateLock.unlock()
            if shouldContinueReceiving {
                self.receiveLoop(task)
            }
        }
    }

    @discardableResult
    func scheduleReconnect(reason: String, immediate: Bool = false) -> Bool {
        guard !isStopping,
              !isRotatingCredential,
              reconnectTask == nil,
              !accessToken.isEmpty,
              sessionResumptionHandle != nil,
              let credentialExpiresAt,
              credentialExpiresAt.timeIntervalSinceNow > 2 else {
            return false
        }

        isSocketOpen = false
        isReadyForRealtimeInput = false
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        let delaySeconds = immediate ? 0 : min(pow(2.0, Double(attempt)), 8)
        emitStatus("Reconnecting: \(reason)")

        reconnectTask = Task { [weak self] in
            if delaySeconds > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            }
            guard let self, !Task.isCancelled, !self.isStopping else { return }
            self.reconnectTask = nil
            self.connectWebSocket(accessToken: self.accessToken)
        }
        return true
    }

    /// Rotates a minute before expiry, leaving room for a retry.
    ///
    /// On a default deployment the call's own 30-minute ceiling and Google's
    /// 30-minute credential expire together, so this timer normally never
    /// fires. It exists for the deployment that raises
    /// `NESSIE_VOICE_MAX_DURATION_MS` past the credential lifetime.
    func scheduleCredentialRotation() {
        credentialRotationTask?.cancel()
        credentialRotationTask = nil

        guard !isStopping, let credentialExpiresAt else { return }
        let delay = max(0, credentialExpiresAt.timeIntervalSinceNow - 60)
        credentialRotationTask = Task { [weak self] in
            if delay > 0 {
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                } catch {
                    return
                }
            }
            guard let self, !Task.isCancelled, !self.isStopping else { return }
            await self.rotateCredential()
        }
    }

    func rotateCredential() async {
        guard !isStopping, !isRotatingCredential else { return }
        isRotatingCredential = true
        reconnectTask?.cancel()
        reconnectTask = nil
        isReadyForRealtimeInput = false
        emitStatus("Refreshing the call")

        var lastError: Error?
        for attempt in 0..<3 {
            do {
                // Keep the old socket alive while provisioning: the voice
                // session id survives rotation, so late usage on the superseded
                // credential is still attributed to this one call.
                let credential = try await credentialProvider(true)
                guard !isStopping, !Task.isCancelled else {
                    isRotatingCredential = false
                    return
                }
                apply(credential)
                reconnectAttempt = 0
                // Install the new task before cancelling the old one, so its
                // close callback cannot start a stale-token reconnect. The
                // resumption handle deliberately survives, which is what keeps
                // the conversation rather than re-seeding it.
                let connected = connectWebSocket(accessToken: credential.accessToken)
                isRotatingCredential = false
                guard connected else { return }
                scheduleCredentialRotation()
                return
            } catch {
                if isStopping || Task.isCancelled {
                    isRotatingCredential = false
                    return
                }
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_000_000_000)
                }
            }
        }

        isRotatingCredential = false
        let detail = lastError?.localizedDescription ?? "unknown error"
        // Under the lock like every other write to these two: a close callback
        // racing this path would otherwise double-cancel.
        let (staleTask, staleSession) = messageStateLock.withLock {
            let task = socketTask
            socketTask = nil
            let session = urlSession
            urlSession = nil
            return (task, session)
        }
        staleTask?.cancel(with: .goingAway, reason: nil)
        staleSession?.invalidateAndCancel()
        finishAfterConnectionLoss("The call could not be renewed: \(detail)")
    }

    func finishAfterConnectionLoss(_ message: String) {
        guard !didNotifyDisconnected else { return }
        didNotifyDisconnected = true
        isSocketOpen = false
        isReadyForRealtimeInput = false
        reconnectTask?.cancel()
        reconnectTask = nil
        credentialRotationTask?.cancel()
        credentialRotationTask = nil
        isRotatingCredential = false
        accessToken = ""
        credentialExpiresAt = nil
        sessionResumptionHandle = nil
        emitStatus(message)
        onEvent?(.disconnected)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        messageStateLock.lock()
        defer { messageStateLock.unlock() }
        guard socketTask === webSocketTask, !isStopping else { return }
        isSocketOpen = true
        isReadyForRealtimeInput = false
        sendSetup()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        messageStateLock.lock()
        defer { messageStateLock.unlock() }
        guard socketTask === webSocketTask, !isStopping else { return }
        isSocketOpen = false
        isReadyForRealtimeInput = false
        let detail: String
        if let reason, let text = String(data: reason, encoding: .utf8), !text.isEmpty {
            detail = "\(closeCode.rawValue) \(text)"
        } else {
            detail = "\(closeCode.rawValue)"
        }
        if isRotatingCredential { return }
        if !scheduleReconnect(reason: "socket closed \(detail)") {
            finishAfterConnectionLoss("The voice service closed the connection (\(detail)).")
        }
    }
}
