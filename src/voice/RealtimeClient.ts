import WebSocket from 'ws'

export type RealtimeCallbacks = {
  onAudioIn?: (audio: Uint8Array) => void
  onTranscript?: (text: string) => void
  onAudioOut?: (audio: Uint8Array) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export class RealtimeClient {
  private ws: WebSocket | null = null
  private callbacks: RealtimeCallbacks
  private apiKey: string
  private model: string

  constructor(options: {
    apiKey: string
    model?: string
    callbacks: RealtimeCallbacks
  }) {
    this.apiKey = options.apiKey
    this.model = options.model ?? 'gpt-realtime-1.5'
    this.callbacks = options.callbacks
  }

  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${this.model}`
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime-v1',
      },
    })

    this.ws.on('open', () => {
      this.callbacks.onConnected?.()
      this.sendSessionConfig()
    })

    this.ws.on('message', (data) => {
      try {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : typeof data === 'string'
              ? data
              : Buffer.from(data).toString('utf8')
        this.handleMessage(JSON.parse(text))
      } catch {
        // ignore parse errors
      }
    })

    this.ws.on('error', () => {
      this.callbacks.onError?.(new Error('WebSocket error'))
    })

    this.ws.on('close', () => {
      this.callbacks.onDisconnected?.()
    })
  }

  disconnect() {
    this.ws?.close()
    this.ws = null
  }

  sendAudio(audio: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Encode(audio),
    }))
  }

  private sendSessionConfig() {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad' },
        tools: [],
      },
    }))
  }

  private handleMessage(data: Record<string, unknown>) {
    switch (data.type) {
      case 'session.created':
        break
      case 'input_audio_buffer.speech_started':
        this.callbacks.onAudioIn?.(new Uint8Array())
        break
      case 'input_audio_buffer.speech_stopped':
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.callbacks.onTranscript?.(String(data.transcript ?? ''))
        break
      case 'response.audio.delta':
        if (data.delta) {
          const audio = base64Decode(String(data.delta))
          this.callbacks.onAudioOut?.(audio)
        }
        break
      case 'response.done':
        break
    }
  }
}

function base64Encode(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]!)
  }
  return btoa(binary)
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
