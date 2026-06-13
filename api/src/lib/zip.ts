import AdmZip from 'adm-zip'

// Listing reads the whole archive into memory (adm-zip parses the central
// directory from a buffer), so cap how big a zip we will read — larger ones stay
// download-only rather than overwhelming the server.
export const ZIP_LIST_MAX_BYTES = 64 * 1024 * 1024
// Inline-preview a single text entry up to this size (decompressed).
export const ZIP_ENTRY_PEEK_MAX_BYTES = 256 * 1024

const TEXT_ENTRY_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log',
  'ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'sh', 'html', 'css', 'ini',
  'toml', 'cfg', 'conf', 'env', 'sql', 'rb', 'java', 'c', 'h', 'cpp', 'php',
])

export type ZipEntry = {
  name: string
  size: number
  compressedSize: number
  isDirectory: boolean
  isText: boolean
}

const entryIsText = (name: string): boolean => {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined
  return ext ? TEXT_ENTRY_EXT.has(ext) : false
}

// List a zip's entries from its central directory (no extraction to disk).
export const listZipEntries = (buffer: Buffer): ZipEntry[] =>
  new AdmZip(buffer).getEntries().map((entry) => ({
    name: entry.entryName,
    size: entry.header.size,
    compressedSize: entry.header.compressedSize,
    isDirectory: entry.isDirectory,
    isText: !entry.isDirectory && entryIsText(entry.entryName),
  }))

// Decompress a single text entry (only that entry, not the whole archive),
// capped. Returns null when the entry is missing or a directory.
export const readZipEntryText = (
  buffer: Buffer,
  entryPath: string,
): { text: string; truncated: boolean } | null => {
  const entry = new AdmZip(buffer).getEntry(entryPath)
  if (!entry || entry.isDirectory) return null
  const data = entry.getData()
  const truncated = data.length > ZIP_ENTRY_PEEK_MAX_BYTES
  const text = (truncated ? data.subarray(0, ZIP_ENTRY_PEEK_MAX_BYTES) : data).toString('utf8')
  return { text, truncated }
}
