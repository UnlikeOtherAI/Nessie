import Foundation

extension GeminiLiveClient {
    /// The opening `setup` frame — the same payload the browser client sends,
    /// because the server contract is the single shared thing between them.
    ///
    /// Automatic voice-activity detection with a long silence window (someone
    /// thinking mid-sentence should not end their turn), interruption allowed
    /// so talking over the model stops it, transcription both ways so the call
    /// has a transcript, and sliding-window compression so a long call does not
    /// die when the context window fills.
    func sendSetup() {
        var payload: [String: Any] = [
            "model": liveModel,
            "generationConfig": [
                "responseModalities": ["AUDIO"],
                "speechConfig": [
                    "voiceConfig": ["prebuiltVoiceConfig": ["voiceName": setup.voiceName]]
                ]
            ],
            "realtimeInputConfig": [
                "automaticActivityDetection": [
                    "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
                    "prefixPaddingMs": 650,
                    "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                    "silenceDurationMs": 2200
                ],
                "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
                "turnCoverage": "TURN_INCLUDES_ONLY_ACTIVITY"
            ],
            "inputAudioTranscription": [:],
            "outputAudioTranscription": [:],
            "sessionResumption": sessionResumptionHandle.map { ["handle": $0] } ?? [:],
            "contextWindowCompression": ["slidingWindow": [:]],
            "systemInstruction": ["parts": [["text": setup.systemInstruction]]]
        ]
        if !setup.functionDeclarations.isEmpty {
            payload["tools"] = [["functionDeclarations": setup.functionDeclarations]]
        }

        sendJSONObject(["setup": payload])
    }

    /// Seeds prior conversation as ordinary role-bearing turns.
    ///
    /// Never folded into `systemInstruction`: history is content the people in
    /// the DM wrote, and the system instruction is the highest-trust tier.
    func sendSeedTurns() {
        guard !setup.seedTurns.isEmpty else { return }
        let turns = setup.seedTurns.map { turn -> [String: Any] in
            ["role": turn.role, "parts": [["text": turn.text]]]
        }
        // Context, not a question: the model must not answer the seed.
        sendJSONObject(["clientContent": ["turns": turns, "turnComplete": false]])
    }

    func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        if let metadata = json["usageMetadata"] as? [String: Any] {
            onEvent?(.usage(metadata))
        }

        if let update = json["sessionResumptionUpdate"] as? [String: Any],
           update["resumable"] as? Bool == true,
           let handle = update["newHandle"] as? String,
           !handle.isEmpty {
            sessionResumptionHandle = handle
        }

        if let toolCall = json["toolCall"] as? [String: Any],
           let functionCalls = toolCall["functionCalls"] as? [[String: Any]] {
            handleToolCalls(functionCalls)
            return
        }

        if let serverContent = json["serverContent"] as? [String: Any] {
            handleServerContent(serverContent)
        }

        if json["setupComplete"] != nil {
            reconnectTask?.cancel()
            reconnectTask = nil
            reconnectAttempt = 0
            isReadyForRealtimeInput = true
            // Seed only on the first connect. A resumed session already holds
            // the conversation, and re-seeding would duplicate it into context
            // Gemini re-bills on every turn.
            if !didSeedContext {
                didSeedContext = true
                sendSeedTurns()
            }
            if !didNotifyConnected {
                didNotifyConnected = true
                onEvent?(.connected)
            } else {
                emitStatus("Reconnected")
            }
            if isAudioActive, !isCapturing {
                do {
                    try startCapture()
                } catch {
                    let message = "The microphone could not start: \(error.localizedDescription)"
                    onEvent?(.failed(message))
                }
            }
        }

        if json["goAway"] != nil {
            // Google is rotating this socket, not ending the call. Resume on
            // the same credential.
            isModelSpeaking = false
            _ = scheduleReconnect(reason: "server rotation", immediate: true)
        }
    }

    func handleServerContent(_ serverContent: [String: Any]) {
        if let output = serverContent["outputTranscription"] as? [String: Any],
           let transcript = output["text"] as? String, !transcript.isEmpty {
            onEvent?(.assistantTranscript(transcript))
        }

        if let input = serverContent["inputTranscription"] as? [String: Any],
           let transcript = input["text"] as? String, !transcript.isEmpty {
            onEvent?(.userTranscript(transcript))
        }

        if let modelTurn = serverContent["modelTurn"] as? [String: Any],
           let parts = modelTurn["parts"] as? [[String: Any]] {
            for part in parts {
                guard let inlineData = part["inlineData"] as? [String: Any],
                      let encoded = inlineData["data"] as? String,
                      let pcmData = Data(base64Encoded: encoded) else {
                    continue
                }
                if !isModelSpeaking {
                    isModelSpeaking = true
                    onEvent?(.modelSpeakingChanged(true))
                }
                playPCM24K(data: pcmData)
            }
        }

        if serverContent["interrupted"] as? Bool == true {
            // The person talked over the model: drop what is already scheduled,
            // or it keeps talking for however much audio was buffered ahead.
            isModelSpeaking = false
            onEvent?(.modelSpeakingChanged(false))
            playerNode.stop()
            playerNode.play()
        }

        if serverContent["turnComplete"] as? Bool == true {
            if isModelSpeaking {
                isModelSpeaking = false
                onEvent?(.modelSpeakingChanged(false))
            }
            onEvent?(.turnComplete)
        }
    }

    func handleToolCalls(_ functionCalls: [[String: Any]]) {
        // Each call runs in its own task. Gemini Live waits happily for a
        // `toolResponse`, so a round trip to the API is fine; blocking the
        // socket receive loop is fatal, which is why this never awaits inline.
        for functionCall in functionCalls {
            let callID = functionCall["id"] as? String ?? UUID().uuidString
            let name = functionCall["name"] as? String ?? ""
            let arguments = functionCall["args"] as? [String: Any] ?? [:]
            // Arguments carry the person's own words. Log shape only; never
            // their values.
            VoiceLog.shape("tool call \(name) argKeys=\(arguments.keys.sorted().joined(separator: ","))")

            Task { [weak self] in
                guard let self else { return }
                let result = await self.toolHandler(callID, name, arguments)
                let payload: [String: Any] = [
                    "toolResponse": ["functionResponses": [[
                        "id": callID,
                        "name": name,
                        "response": ["result": result]
                    ]]]
                ]
                if JSONSerialization.isValidJSONObject(payload) {
                    self.sendJSONObject(payload)
                } else {
                    self.sendJSONObject([
                        "toolResponse": ["functionResponses": [[
                            "id": callID,
                            "name": name,
                            "response": ["result": ["ok": false, "error": "internal serialization error"]]
                        ]]]
                    ])
                }
            }
        }
    }

    func sendRealtimeInput(_ payload: [String: Any]) {
        sendJSONObject(["realtimeInput": payload])
    }

    func sendJSONObject(_ payload: [String: Any]) {
        guard let messageData = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: messageData, encoding: .utf8) else {
            return
        }
        socketTask?.send(.string(text)) { _ in }
    }

    func emitStatus(_ message: String) {
        VoiceLog.shape(message)
        onEvent?(.status(message))
    }
}
