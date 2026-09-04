import { detectSecrets } from '@nessie/schemas'

const utf16Text = (
  bytes: Buffer,
  byteOrder: 'be' | 'le',
  offset: number,
): string => {
  const body = bytes.subarray(offset, bytes.length - ((bytes.length - offset) % 2))
  if (byteOrder === 'le') return body.toString('utf16le')
  const swapped = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 2) {
    swapped[index] = body[index + 1]!
    swapped[index + 1] = body[index]!
  }
  return swapped.toString('utf16le')
}

const inferredUtf16ByteOrder = (bytes: Buffer): 'be' | 'le' | null => {
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096)
  if (sampleLength < 8) return null
  let evenNulls = 0
  let oddNulls = 0
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNulls++
    if (bytes[index + 1] === 0) oddNulls++
  }
  const pairs = sampleLength / 2
  if (oddNulls / pairs > 0.3 && evenNulls / pairs < 0.1) return 'le'
  if (evenNulls / pairs > 0.3 && oddNulls / pairs < 0.1) return 'be'
  return null
}

/** Scan raw UTF-8/ASCII bytes and the common UTF-16 text encodings. */
export const uploadContainsDetectedSecret = (bytes: Buffer): boolean => {
  if (detectSecrets(bytes.toString('utf8')).length > 0) return true
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return detectSecrets(utf16Text(bytes, 'le', 2)).length > 0
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return detectSecrets(utf16Text(bytes, 'be', 2)).length > 0
  }
  const inferred = inferredUtf16ByteOrder(bytes)
  return inferred ? detectSecrets(utf16Text(bytes, inferred, 0)).length > 0 : false
}
