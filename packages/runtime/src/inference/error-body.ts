const LLM_ERROR_BODY_MAX_BYTES = 8 * 1024
const LLM_ERROR_BODY_MAX_CHARS = 400

export async function readErrorBodySnippet(res: Response): Promise<string> {
  try {
    const body = res.body
    if (!body || typeof body.getReader !== 'function') {
      return (await res.text()).slice(0, LLM_ERROR_BODY_MAX_CHARS)
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || !value?.byteLength) break
        const remaining = LLM_ERROR_BODY_MAX_BYTES - total
        if (remaining <= 0) { truncated = true; break }
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncated = true
          break
        }
        chunks.push(value)
        total += value.byteLength
        if (total >= LLM_ERROR_BODY_MAX_BYTES) { truncated = true; break }
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => undefined)
      try { reader.releaseLock() } catch {}
    }
    return new TextDecoder().decode(Buffer.concat(chunks, total)).slice(0, LLM_ERROR_BODY_MAX_CHARS)
  } catch {
    return ''
  }
}
