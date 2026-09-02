/**
 * Browser audio for a Gemini Live call: microphone capture at 16 kHz and
 * gapless playback of the model's 24 kHz PCM.
 *
 * Both rates are fixed by the Gemini Live wire format, not by us — input is
 * `audio/pcm;rate=16000`, output arrives as raw 24 kHz mono Int16 chunks. The
 * capture side lives in an AudioWorklet (`/voice-capture-worklet.js`) so the
 * resampling never runs on the main thread.
 */

const INPUT_SAMPLE_RATE = 16_000
export const OUTPUT_SAMPLE_RATE = 24_000

/** Where the worklet module is served from; it is a static admin asset. */
const CAPTURE_WORKLET_URL = '/voice-capture-worklet.js'

export type VoiceCaptureHandlers = {
  /** One frame of mono 16 kHz Int16 PCM, ready to base64 onto the socket. */
  onFrame: (frame: Int16Array) => void
}

export type VoiceCapture = {
  setMuted: (muted: boolean) => void
  stop: () => Promise<void>
}

/**
 * Opens the microphone and streams 16 kHz PCM frames to `onFrame`.
 *
 * Echo cancellation and noise suppression are left on: without them the model
 * hears its own voice through the speakers and interrupts itself, which reads
 * as the assistant talking over the person.
 */
export const startVoiceCapture = async (
  handlers: VoiceCaptureHandlers,
): Promise<VoiceCapture> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  // Ask for the target rate directly. Browsers may ignore it and keep the
  // hardware rate, which is why the worklet resamples from `sampleRate`
  // rather than assuming it got what it asked for.
  const context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
  try {
    await context.audioWorklet.addModule(CAPTURE_WORKLET_URL)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => undefined)
    throw error
  }

  const source = context.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(context, 'voice-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { targetSampleRate: INPUT_SAMPLE_RATE },
  })
  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    handlers.onFrame(new Int16Array(event.data))
  }
  source.connect(worklet)

  // Autoplay policy can leave a context suspended even when the call started
  // from a click; resuming is a no-op when it is already running.
  await context.resume().catch(() => undefined)

  return {
    setMuted: (muted: boolean) => {
      worklet.port.postMessage({ type: 'mute', muted })
    },
    stop: async () => {
      worklet.port.onmessage = null
      source.disconnect()
      worklet.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      await context.close().catch(() => undefined)
    },
  }
}

export type VoicePlayback = {
  /** Queue one chunk of mono 24 kHz Int16 PCM for playback. */
  enqueue: (pcm: Int16Array) => void
  /** Drop everything not yet played — the model was interrupted. */
  flush: () => void
  setMuted: (muted: boolean) => void
  stop: () => Promise<void>
}

/**
 * Schedules the model's audio chunks back-to-back on the WebAudio clock.
 *
 * Chunks arrive faster than real time, so playing each one on arrival would
 * overlap them. Instead each buffer is scheduled at the end of the previous
 * one; `nextStartTime` is the running cursor, nudged forward when the queue
 * has drained (a gap in delivery) so playback never tries to start in the
 * past.
 */
export const createVoicePlayback = (): VoicePlayback => {
  const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
  const gain = context.createGain()
  gain.connect(context.destination)

  let nextStartTime = 0
  let sources = new Set<AudioBufferSourceNode>()

  return {
    enqueue: (pcm: Int16Array) => {
      if (pcm.length === 0) return
      const buffer = context.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE)
      const channel = buffer.getChannelData(0)
      for (let i = 0; i < pcm.length; i += 1) {
        const sample = pcm[i] ?? 0
        channel[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
      }

      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      // A small lead keeps the first chunk from being scheduled in the past
      // while the context is still warming up.
      const startAt = Math.max(nextStartTime, context.currentTime + 0.02)
      source.start(startAt)
      nextStartTime = startAt + buffer.duration

      sources.add(source)
      source.onended = () => {
        sources.delete(source)
      }
      void context.resume().catch(() => undefined)
    },
    flush: () => {
      // An interruption must silence what is already scheduled, not just stop
      // adding to it — otherwise the model keeps talking over the person for
      // however much audio was buffered ahead.
      for (const source of sources) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // Already finished; nothing to stop.
        }
      }
      sources = new Set()
      nextStartTime = 0
    },
    setMuted: (muted: boolean) => {
      gain.gain.value = muted ? 0 : 1
    },
    stop: async () => {
      for (const source of sources) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // Already finished.
        }
      }
      sources = new Set()
      await context.close().catch(() => undefined)
    },
  }
}

/** Base64 for the raw bytes of a PCM frame, as Gemini Live's wire format wants. */
export const encodePcmFrame = (frame: Int16Array): string => {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
  let binary = ''
  // Chunked so a long frame cannot blow the argument limit of String.fromCharCode.
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** Inverse of {@link encodePcmFrame} for the model's 24 kHz audio parts. */
export const decodePcmChunk = (base64: string): Int16Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  // A chunk boundary can split a sample; drop a trailing odd byte rather than
  // reading past the buffer.
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
}
