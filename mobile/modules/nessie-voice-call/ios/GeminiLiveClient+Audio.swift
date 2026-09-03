import AVFoundation
import Foundation

extension GeminiLiveClient {
    /// Configures the category before anything is minted.
    ///
    /// Proving the local audio path first is deliberate: the Gemini credential
    /// is one-use and holds a daily budget reservation, so an audio failure
    /// after minting burns one until it expires. CallKit *activates* the
    /// session; the category is still ours to declare.
    static func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
        if #available(iOS 26.0, *) {
            options.insert(.allowBluetoothHFP)
        } else {
            options.insert(.allowBluetooth)
        }
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try session.setPreferredSampleRate(16_000)
        try session.setPreferredIOBufferDuration(0.01)
    }

    /// Asks for the microphone, in the foreground, before the call is placed.
    ///
    /// It has to happen here rather than at first capture. CallKit activates the
    /// audio session itself, potentially with the screen locked, and iOS will
    /// not put a permission prompt in front of a locked phone — the engine would
    /// simply record silence and the assistant would sit there hearing nothing.
    /// Asking while the person is looking at the button they just pressed is
    /// also when the request makes sense to them.
    static func requestMicrophoneAccess() async -> Bool {
        if #available(iOS 17.0, *) {
            return await AVAudioApplication.requestRecordPermission()
        }
        return await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    func startPlayback() throws {
        guard let playerFormat else { throw GeminiLiveError.audioFormatUnavailable }
        if playerNode.engine == nil {
            playbackEngine.attach(playerNode)
        }
        // Reconnected on every start, not only the first: a route change breaks
        // the graph's connections, and a silent playback engine is exactly how
        // audio "dies for no reason" after AirPods are pulled out.
        playbackEngine.connect(playerNode, to: playbackEngine.mainMixerNode, format: playerFormat)
        try playbackEngine.start()
        playerNode.play()
    }

    func startCapture() throws {
        guard isAudioActive, !isCapturing else { return }
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw GeminiLiveError.noMicrophoneInput }
        guard let captureFormat = GeminiLiveClient.captureFormat else {
            throw GeminiLiveError.audioFormatUnavailable
        }

        // Built here rather than once at init: the hardware input format is not
        // known until the session is configured and a route is chosen, and it
        // changes again on every route change. A converter left pointing at the
        // old rate produces garbage the model hears as noise.
        inputConverter = AVAudioConverter(from: inputFormat, to: captureFormat)

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.send(buffer: buffer)
        }

        do {
            try audioEngine.start()
            isCapturing = true
        } catch {
            inputNode.removeTap(onBus: 0)
            audioEngine.stop()
            throw error
        }
    }

    func send(buffer: AVAudioPCMBuffer) {
        guard isReadyForRealtimeInput, !isModelSpeaking else { return }
        // Held is not muted. Muting keeps a silent stream flowing so Gemini's
        // automatic VAD can still see the end of an utterance; holding stops
        // sending altogether, because a call the system took away must not keep
        // feeding a turn that will be billed and answered into nowhere.
        guard !isHeld else { return }
        guard let converted = convertToPCM16(buffer: buffer),
              let channelData = converted.int16ChannelData else { return }

        let frameCount = Int(converted.frameLength)
        let byteCount = frameCount * MemoryLayout<Int16>.size
        let data = isInputMuted
            ? Data(count: byteCount)
            : Data(bytes: channelData[0], count: byteCount)
        sendRealtimeInput([
            "audio": ["mimeType": "audio/pcm;rate=16000", "data": data.base64EncodedString()]
        ])
    }

    func convertToPCM16(buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let inputConverter else { return nil }
        let outputFormat = inputConverter.outputFormat
        let ratio = 16_000.0 / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return nil
        }

        var error: NSError?
        var didProvideInput = false
        let status = inputConverter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return buffer
        }
        return status == .error ? nil : outputBuffer
    }

    func playPCM24K(data: Data) {
        guard isAudioActive, !isHeld, let playerFormat else { return }
        let bytesPerFrame = Int(playerFormat.streamDescription.pointee.mBytesPerFrame)
        guard bytesPerFrame > 0 else { return }
        let frameCapacity = UInt32(data.count / bytesPerFrame)
        guard frameCapacity > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: frameCapacity),
              let channel = buffer.int16ChannelData else {
            return
        }
        buffer.frameLength = frameCapacity
        data.copyBytes(
            to: UnsafeMutableRawBufferPointer(start: channel[0], count: Int(frameCapacity) * bytesPerFrame)
        )
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }

    // MARK: - Route changes

    /// AirPods pulled out, a car head unit taking over, the speaker toggled.
    ///
    /// The platform picks the route; the *engine* does not follow it. Its input
    /// node reports a new hardware format, the installed tap and the sample-rate
    /// converter are both stale, and the playback graph's connections are
    /// broken — all of which present as audio dying mid-call with no error
    /// anywhere. Rebuilding the pipeline on both notifications is the fix.
    func observeAudioRouteChanges() {
        stopObservingAudioRouteChanges()
        routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
        engineConfigurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reconfigureAudio(reason: "the audio engine reconfigured")
        }
    }

    func stopObservingAudioRouteChanges() {
        if let routeChangeObserver {
            NotificationCenter.default.removeObserver(routeChangeObserver)
            self.routeChangeObserver = nil
        }
        if let engineConfigurationObserver {
            NotificationCenter.default.removeObserver(engineConfigurationObserver)
            self.engineConfigurationObserver = nil
        }
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else {
            return
        }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable, .override,
             .routeConfigurationChange, .categoryChange:
            reconfigureAudio(reason: "the audio route changed")
        default:
            break
        }
    }

    private func reconfigureAudio(reason: String) {
        guard isAudioActive, !isStopping else { return }
        emitStatus(reason)
        let shouldCapture = isCapturing || isReadyForRealtimeInput
        stopAudioEngines()
        isAudioActive = true
        do {
            try startPlayback()
            if shouldCapture { try startCapture() }
        } catch {
            stopAudioEngines()
            onEvent?(.failed("Audio stopped after \(reason): \(error.localizedDescription)"))
        }
    }

    func stopAudioEngines() {
        if isCapturing || audioEngine.isRunning {
            audioEngine.stop()
        }
        if isCapturing {
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        isCapturing = false
        playerNode.stop()
        playbackEngine.stop()
        isAudioActive = false
    }
}
