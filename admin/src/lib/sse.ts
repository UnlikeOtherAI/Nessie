export type SseFrame = {
  data?: string
  event?: string
  id?: string
}

const readFieldValue = (line: string): { field: string; value: string } => {
  const separatorIndex = line.indexOf(':')
  if (separatorIndex === -1) {
    return { field: line, value: '' }
  }

  const value = line.slice(separatorIndex + 1)
  return {
    field: line.slice(0, separatorIndex),
    value: value.startsWith(' ') ? value.slice(1) : value,
  }
}

const parseFrame = (rawFrame: string): SseFrame | null => {
  const frame: SseFrame = {}
  const dataLines: string[] = []

  for (const line of rawFrame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) {
      continue
    }

    const { field, value } = readFieldValue(line)
    if (field === 'id') {
      frame.id = value
      continue
    }

    if (field === 'event') {
      frame.event = value
      continue
    }

    if (field === 'data') {
      dataLines.push(value)
    }
  }

  if (dataLines.length > 0) {
    frame.data = dataLines.join('\n')
  }

  return frame.data || frame.event || frame.id ? frame : null
}

export const readSseStream = async (
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => Promise<void> | void,
): Promise<void> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processFrame = async (rawFrame: string): Promise<void> => {
    const frame = parseFrame(rawFrame)
    if (frame) {
      await onFrame(frame)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        await processFrame(frame)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      await processFrame(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}
