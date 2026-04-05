import Foundation
import Speech

class HotwordDetector: ObservableObject {
  @Published var isListening = false

  func start() {
    isListening = true
    // Keyword spotting not yet implemented (SFSpeechRecognizer / Apple Neural Engine)
  }

  func stop() {
    isListening = false
  }
}
