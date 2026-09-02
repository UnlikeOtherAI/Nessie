/**
 * Microphone capture worklet for Gemini Live calls.
 *
 * Gemini Live wants mono 16 kHz signed 16-bit PCM. A browser's AudioContext
 * runs at the hardware rate (typically 48 kHz), so this processor decimates to
 * 16 kHz and converts to Int16 on the audio thread, posting whole frames to
 * the main thread. Doing it here rather than in a ScriptProcessor keeps the
 * conversion off the main thread, where a long task would drop microphone
 * samples mid-utterance.
 *
 * Muting is deliberately "send silence", not "send nothing" (the same choice
 * Coder's iOS client makes): Gemini's automatic voice-activity detection needs
 * a continuous stream to observe the end of an utterance, so cutting the
 * stream entirely leaves the model waiting forever. No microphone samples
 * leave the process while muted.
 */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const targetRate = options?.processorOptions?.targetSampleRate ?? 16000
    // `sampleRate` is a global in the AudioWorkletGlobalScope.
    this.ratio = sampleRate / targetRate
    // Fractional read position into the input block, carried across blocks so
    // a non-integer decimation ratio (48000/16000 is 3, but 44100/16000 is
    // 2.75625) does not drift or repeat samples at every block boundary.
    this.position = 0
    this.muted = false
    // ~40 ms of 16 kHz audio per message. Small enough that the far end hears
    // no added latency; large enough that we are not posting hundreds of
    // messages a second.
    this.frame = new Int16Array(640)
    this.frameOffset = 0

    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = event.data.muted === true
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    while (this.position < channel.length) {
      const sample = this.muted ? 0 : channel[Math.floor(this.position)]
      // Clamp before scaling: a sample outside [-1, 1] (possible after gain)
      // would wrap around to the opposite sign as Int16 and read as a click.
      const clamped = Math.max(-1, Math.min(1, sample))
      this.frame[this.frameOffset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.position += this.ratio

      if (this.frameOffset === this.frame.length) {
        // Transfer a copy: the worklet keeps writing into `this.frame`.
        const out = this.frame.slice()
        this.port.postMessage(out.buffer, [out.buffer])
        this.frameOffset = 0
      }
    }
    this.position -= channel.length

    return true
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor)
