export type ModelUsageRecord = {
  model: string
  inputTokens: number
  outputTokens: number
  calls: number
}

export class ModelUsageTracker {
  private records = new Map<
    string,
    { inputTokens: number; outputTokens: number; calls: number }
  >()

  record(model: string, inputTokens: number, outputTokens: number): void {
    const existing = this.records.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
    }
    existing.inputTokens += inputTokens
    existing.outputTokens += outputTokens
    existing.calls += 1
    this.records.set(model, existing)
  }

  getUsage(): ModelUsageRecord[] {
    return Array.from(this.records.entries()).map(([model, data]) => ({
      model,
      ...data,
    }))
  }

  getTotalTokens(): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0
    let outputTokens = 0
    for (const data of this.records.values()) {
      inputTokens += data.inputTokens
      outputTokens += data.outputTokens
    }
    return { inputTokens, outputTokens }
  }

  reset(): void {
    this.records.clear()
  }
}
