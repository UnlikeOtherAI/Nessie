import Foundation
import AVFoundation

class VoiceManager: ObservableObject {
  @Published var isListening = false
  @Published var isSpeaking = false

  private var audioEngine: AVAudioEngine?

  func startListening() {
    isListening = true
  }

  func stopListening() {
    audioEngine?.stop()
    isListening = false
  }
}
