import type { LocalInferenceHostLoop } from './local-inference-host.js'

/** The host serializes admission; active generations may fill shared capacity. */
export class LocalInferencePollPump {
  private readonly pending = new Set<Promise<unknown>>()
  private stopped = false

  constructor(
    private readonly loop: Pick<LocalInferenceHostLoop, 'pollOnce' | 'stop'>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  tick(): void {
    if (this.stopped) return
    const operation = this.loop.pollOnce().catch(this.onError).finally(() => { this.pending.delete(operation) })
    this.pending.add(operation)
  }

  async stop(): Promise<void> {
    if (!this.stopped) { this.stopped = true; this.loop.stop() }
    await Promise.allSettled(this.pending)
  }
}
