import {
  faFile,
  faFileAudio,
  faFileCode,
  faFileCsv,
  faFileExcel,
  faFileImage,
  faFileLines,
  faFilePdf,
  faFilePowerpoint,
  faFileVideo,
  faFileWord,
  faFileZipper,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

// Map a filename extension to a FontAwesome icon. File nodes are titled with
// their filename, so the browser can pick an icon without fetching the blob.
const EXTENSION_ICONS: Record<string, IconDefinition> = {
  pdf: faFilePdf,
  doc: faFileWord,
  docx: faFileWord,
  rtf: faFileWord,
  xls: faFileExcel,
  xlsx: faFileExcel,
  ods: faFileExcel,
  csv: faFileCsv,
  tsv: faFileCsv,
  ppt: faFilePowerpoint,
  pptx: faFilePowerpoint,
  key: faFilePowerpoint,
  png: faFileImage,
  jpg: faFileImage,
  jpeg: faFileImage,
  gif: faFileImage,
  webp: faFileImage,
  svg: faFileImage,
  heic: faFileImage,
  zip: faFileZipper,
  gz: faFileZipper,
  tar: faFileZipper,
  rar: faFileZipper,
  '7z': faFileZipper,
  mp3: faFileAudio,
  wav: faFileAudio,
  m4a: faFileAudio,
  flac: faFileAudio,
  mp4: faFileVideo,
  mov: faFileVideo,
  webm: faFileVideo,
  mkv: faFileVideo,
  txt: faFileLines,
  md: faFileLines,
  json: faFileCode,
  xml: faFileCode,
  yml: faFileCode,
  yaml: faFileCode,
  ts: faFileCode,
  js: faFileCode,
  tsx: faFileCode,
  jsx: faFileCode,
  py: faFileCode,
  go: faFileCode,
  rs: faFileCode,
  sh: faFileCode,
  html: faFileCode,
  css: faFileCode,
}

const fileExtension = (filename: string): string | undefined =>
  filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

// Markdown is the KB's native document format — an uploaded `.md` is opened as a
// real document (rendered + editable), not shown as a raw file blob.
export const isMarkdownFilename = (filename: string): boolean => {
  const ext = fileExtension(filename)
  return ext ? MARKDOWN_EXT.has(ext) : false
}

export const isZipFilename = (filename: string): boolean => fileExtension(filename) === 'zip'

export const iconForFilename = (filename: string): IconDefinition => {
  const ext = fileExtension(filename)
  return (ext && EXTENSION_ICONS[ext]) || faFile
}

export const iconForMime = (mime: string): IconDefinition => {
  if (mime.startsWith('image/')) return faFileImage
  if (mime.startsWith('audio/')) return faFileAudio
  if (mime.startsWith('video/')) return faFileVideo
  if (mime === 'application/pdf') return faFilePdf
  if (mime === 'text/csv') return faFileCsv
  if (mime.includes('spreadsheet') || mime.includes('excel')) return faFileExcel
  if (mime.includes('word') || mime.includes('document')) return faFileWord
  if (mime.includes('presentation') || mime.includes('powerpoint')) return faFilePowerpoint
  if (mime.includes('zip') || mime.includes('compressed')) return faFileZipper
  if (mime.startsWith('text/')) return faFileLines
  return faFile
}

// Whether a MIME type can be previewed inline in the browser.
export const canPreviewInline = (mime: string): boolean =>
  mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('text/') || mime === 'text/csv'

export type PreviewKind = 'image' | 'pdf' | 'text' | null

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
const TEXT_EXT = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log',
  'ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'sh', 'html', 'css',
])

// How a file node should be previewed in the viewer, inferred from its filename
// (file nodes are titled with their filename). Returns null when not previewable.
export const previewKindForFilename = (filename: string): PreviewKind => {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  if (!ext) return null
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXT.has(ext)) return 'text'
  return null
}
