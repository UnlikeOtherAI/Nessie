import type { Readable } from 'node:stream'

// Read a stream into a buffer, bailing (null) once it exceeds `maxBytes`.
// Callers use this only where full bytes are unavoidable (zip inspection and
// the upload cap); canonical Markdown projection reads through @nessie/knowledge.
export const readStreamCapped = async (
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | null> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > maxBytes) {
      stream.destroy()
      return null
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
