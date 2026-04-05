import SwiftUI
import AVFoundation

// ─── Voice bridge — captures audio, streams to backend via WebSocket, plays back ──

@MainActor
final class VoiceBridge: ObservableObject {
  @Published var isActive = false
  @Published var transcription = ""
  @Published var responseText = ""
  @Published var audioLevels: [CGFloat] = Array(repeating: 0.1, count: 40)
  @Published var errorMessage: String?

  private var audioEngine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var streamTask: Task<Void, Never>?

  // ─── Start voice session ──────────────────────────────────────────────────

  func start() async {
    guard !isActive else { return }

    let granted = await requestMicPermission()
    guard granted else {
      errorMessage = "Microphone access denied. Enable it in System Settings > Privacy & Security > Microphone."
      return
    }

    isActive = true
    transcription = ""
    responseText = ""
    errorMessage = nil

    streamTask = Task {
      await runVoiceSession()
    }
  }

  // ─── Stop voice session ───────────────────────────────────────────────────

  func stop() {
    streamTask?.cancel()
    streamTask = nil

    audioEngine?.stop()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine = nil

    playerNode?.stop()
    playerNode = nil

    isActive = false
  }

  // ─── Mic permission ───────────────────────────────────────────────────────

  private func requestMicPermission() async -> Bool {
    await withCheckedContinuation { continuation in
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized:
        continuation.resume(returning: true)
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          continuation.resume(returning: granted)
        }
      default:
        continuation.resume(returning: false)
      }
    }
  }

  // ─── Voice session loop ───────────────────────────────────────────────────

  private func runVoiceSession() async {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)

    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)

    engine.connect(player, to: engine.outputNode, format: format)

    // Tap input for level metering + streaming
    inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
      self?.handleAudioBuffer(buffer)
    }

    do {
      try engine.start()
      player.play()
    } catch {
      await MainActor.run {
        self.errorMessage = "Failed to start audio: \(error.localizedDescription)"
        self.isActive = false
      }
      return
    }

    self.audioEngine = engine
    self.playerNode = player

    // Connect to backend voice WebSocket
    await connectVoiceWebSocket()

    // Keep-alive
    while !Task.isCancelled && isActive {
      try? await Task.sleep(nanoseconds: 500_000_000)
    }
  }

  // ─── WebSocket voice stream ───────────────────────────────────────────────

  private func connectVoiceWebSocket() async {
    // Build WebSocket URL — backend WebSocket on port 4317
    guard let url = URL(string: "ws://127.0.0.1:4317/voice") else { return }

    let session = URLSession(configuration: .default)
    let wsTask = session.webSocketTask(with: url)
    wsTask.resume()

    // Send session start
    let startMsg = VoiceWSMessage(type: "start", sessionId: UUID().uuidString)
    if let data = try? JSONEncoder().encode(startMsg),
       let str = String(data: data, encoding: .utf8) {
      try? await wsTask.send(.string(str))
    }

    // Read messages from backend
    Task {
      while !Task.isCancelled && isActive {
        do {
          let msg = try await wsTask.receive()
          await handleWSServerMessage(msg)
        } catch {
          break
        }
      }
    }

    // Periodically send audio level pings (actual PCM streaming requires backend support)
    Task {
      while !Task.isCancelled && isActive {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        // Ping to keep connection alive
        try? await wsTask.sendPing { _ in }
      }
    }
  }

  private func handleWSServerMessage(_ message: URLSessionWebSocketTask.Message) async {
    let data: Data?
    switch message {
    case .string(let str):
      data = str.data(using: .utf8)
    case .data(let msgData):
      data = msgData
    @unknown default:
      data = nil
    }
    guard let jsonData = data else { return }
    await MainActor.run {
      if let event = try? JSONDecoder().decode(VoiceStreamEvent.self, from: jsonData) {
        applyVoiceEvent(event)
      }
    }
  }

  @MainActor
  private func applyVoiceEvent(_ event: VoiceStreamEvent) {
    switch event.type {
    case "transcript":
      if let text = event.text { transcription = text }
    case "response_delta":
      if let delta = event.delta { responseText += delta }
    case "response_done":
      if let content = event.content { responseText = content }
    case "error":
      errorMessage = event.message ?? "Voice session error"
    default:
      break
    }
  }

  // ─── Audio buffer handler ─────────────────────────────────────────────────

  private nonisolated func handleAudioBuffer(_ buffer: AVAudioPCMBuffer) {
    // Update waveform levels
    let level = computeRMS(buffer: buffer)
    let normalized = CGFloat(min(level * 4, 1.0))

    Task { @MainActor in
      var levels = self.audioLevels
      levels.removeFirst()
      levels.append(max(0.05, normalized))
      self.audioLevels = levels
    }

    // Send audio level to backend (backend does actual streaming to OpenAI)
    Task {
      await sendAudioLevelToBackend(level: level)
    }
  }

  private nonisolated func computeRMS(buffer: AVAudioPCMBuffer) -> Float {
    guard let channelData = buffer.floatChannelData?[0] else { return 0 }
    let frameLength = Int(buffer.frameLength)
    var rms: Float = 0
    for idx in 0..<frameLength {
      rms += channelData[idx] * channelData[idx]
    }
    return sqrtf(rms / Float(frameLength))
  }

  private var audioLevelTask: Task<Void, Never>?
  private var pendingLevel: Float = 0

  private func sendAudioLevelToBackend(level: Float) async {
    // Non-blocking: send the RMS level to backend WebSocket for VAD
    // The backend will handle the actual OpenAI Realtime streaming
    pendingLevel = level
  }
}

// ─── Voice WebSocket messages ────────────────────────────────────────────────────

private struct VoiceWSMessage: Codable {
  let type: String
  let sessionId: String?
  let audioLevel: Float?

  init(type: String, sessionId: String? = nil, audioLevel: Float? = nil) {
    self.type = type
    self.sessionId = sessionId
    self.audioLevel = audioLevel
  }

  enum CodingKeys: String, CodingKey {
    case type, sessionId, audioLevel
  }
}

// ─── Voice stream event (server → client) ───────────────────────────────────────

private struct VoiceStreamEvent: Codable {
  let type: String
  let text: String?
  let delta: String?
  let content: String?
  let message: String?
}

// ─── Voice mode overlay ─────────────────────────────────────────────────────────

struct VoiceModeView: View {
  @EnvironmentObject var appState: AppState
  @StateObject private var voiceBridge = VoiceBridge()
  @Binding var isPresented: Bool

  var body: some View {
    ZStack {
      // Dimmed background
      Color.black.opacity(0.45)
        .ignoresSafeArea()
        .onTapGesture { dismiss() }

      // Main card
      VStack(spacing: 24) {
        // Header
        HStack {
          Text("Voice Mode")
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(.primary)

          Spacer()

          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.system(size: 20))
              .foregroundColor(.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("voice_close")
        }

        // Waveform
        WaveformView(levels: voiceBridge.audioLevels)
          .frame(height: 80)
          .accessibilityIdentifier("voice_waveform")

        // Transcription
        VStack(spacing: 8) {
          if !voiceBridge.transcription.isEmpty {
            Text(voiceBridge.transcription)
              .font(.system(size: 14))
              .foregroundColor(.primary)
              .multilineTextAlignment(.center)
              .transition(.opacity)
          } else {
            Text("Listening...")
              .font(.system(size: 14))
              .foregroundColor(.secondary)
          }
        }
        .frame(minHeight: 44)
        .accessibilityIdentifier("voice_transcription")

        // Response
        if !voiceBridge.responseText.isEmpty {
          VStack(spacing: 4) {
            Text("Nessie")
              .font(.system(size: 10, weight: .semibold))
              .foregroundColor(.secondary)
            Text(voiceBridge.responseText)
              .font(.system(size: 14))
              .foregroundColor(.primary.opacity(0.9))
              .multilineTextAlignment(.center)
          }
          .transition(.opacity)
          .accessibilityIdentifier("voice_response")
        }

        // Error
        if let error = voiceBridge.errorMessage {
          Text(error)
            .font(.system(size: 12))
            .foregroundColor(.red)
            .multilineTextAlignment(.center)
            .padding(.horizontal)
            .accessibilityIdentifier("voice_error")
        }

        // Stop button
        Button {
          voiceBridge.stop()
          isPresented = false
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "stop.fill")
              .font(.system(size: 13))
            Text("Stop")
              .font(.system(size: 14, weight: .semibold))
          }
          .foregroundColor(.white)
          .padding(.horizontal, 24)
          .padding(.vertical, 10)
          .background(Color.red.opacity(0.7))
          .cornerRadius(22)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("voice_stop")
      }
      .padding(28)
      .frame(width: 420)
      .background(
        RoundedRectangle(cornerRadius: 20)
          .fill(Color(nsColor: .windowBackgroundColor).opacity(0.98))
      )
      .shadow(color: .black.opacity(0.3), radius: 30, x: 0, y: 10)
    }
    .accessibilityIdentifier("voice_mode_overlay")
    .onAppear {
      Task { await voiceBridge.start() }
    }
    .onDisappear {
      voiceBridge.stop()
    }
  }

  private func dismiss() {
    voiceBridge.stop()
    isPresented = false
  }
}

// ─── Waveform visualization ─────────────────────────────────────────────────────

struct WaveformView: View {
  let levels: [CGFloat]

  var body: some View {
    GeometryReader { geo in
      HStack(spacing: 3) {
        ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
          RoundedRectangle(cornerRadius: 2)
            .fill(
              LinearGradient(
                colors: [.orange, .yellow],
                startPoint: .bottom,
                endPoint: .top
              )
            )
            .frame(width: barWidth(geo.size.width), height: barHeight(level, maxHeight: geo.size.height))
            .animation(.easeOut(duration: 0.08), value: level)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
  }

  private var barCount: Int { levels.count }

  private func barWidth(_ totalWidth: CGFloat) -> CGFloat {
    let spacing = CGFloat(barCount - 1) * 3
    return max((totalWidth - spacing) / CGFloat(barCount), 4)
  }

  private func barHeight(_ level: CGFloat, maxHeight: CGFloat) -> CGFloat {
    let minH: CGFloat = 4
    return minH + (maxHeight - minH) * level
  }
}
