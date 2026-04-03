import Foundation
import Speech
import SoundAnalysis

class HotwordDetector: ObservableObject {
  @Published var isListening = false

  func start() {
    isListening = true
    // TODO: implement keyword spotting using SFSpeechRecognizer
    // or Apple Neural Engine for low-power wake word
  }

  func stop() {
    isListening = false
  }
}
