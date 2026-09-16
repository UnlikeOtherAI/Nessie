/**
 * The one number the import cap needs that `@nessie/spreadsheet`'s warning
 * scanner does not expose: how much this package declares it will expand to.
 *
 * It has to be the *uncompressed* size, not the file size. Sheet XML
 * decompresses about 11:1 and a 3.27 MB workbook already needs ~864 MB
 * resident, so a cap on the upload alone admits a file that takes the process
 * down (spike B §"Contract changes" 5). The figure comes from the central
 * directory, so nothing is inflated to learn it.
 *
 * TODO(Phase 1): `readCentralDirectory` in
 * `packages/spreadsheet/src/xlsx-warnings.ts` already parses this field's
 * neighbour. When it exports `uncompressedSize`, delete this file.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/** Null when the bytes are not a readable 32-bit zip at all. */
export const declaredUncompressedBytes = (bytes: Buffer): number | null => {
  const search = Math.min(bytes.length, 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= bytes.length - search && offset >= 0; offset--) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd === -1) return null

  const count = bytes.readUInt16LE(eocd + 10)
  let cursor = bytes.readUInt32LE(eocd + 16)
  let total = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null
    total += bytes.readUInt32LE(cursor + 24)
    cursor +=
      46
      + bytes.readUInt16LE(cursor + 28)
      + bytes.readUInt16LE(cursor + 30)
      + bytes.readUInt16LE(cursor + 32)
  }
  return total
}
