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

export type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | null

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'apng', 'jfif', 'pjpeg',
])
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'm4v', 'mov'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'])
const TEXT_EXT = new Set([
  // data / config
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties', 'log', 'diff', 'patch', 'srt', 'vtt',
  // code
  'ts', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'java', 'kt', 'kts', 'swift', 'scala', 'php',
  'pl', 'lua', 'r', 'sql', 'graphql', 'gql', 'proto', 'gradle', 'groovy', 'dart', 'ex', 'exs',
  'erl', 'clj', 'hs', 'elm', 'vue', 'svelte', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less',
])
// Common text files that carry no extension.
const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'licence', 'changelog', 'authors', 'notice',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'prettierrc', 'eslintrc',
])

// How a file node should be previewed in the viewer, inferred from its filename
// (file nodes are titled with their filename). Returns null when not previewable
// inline — those fall back to a typed download card. Office documents (doc(x),
// xls(x), ppt(x)) can't render in-browser without an external converter, so they
// intentionally stay download-only.
export const previewKindForFilename = (filename: string): PreviewKind => {
  const base = filename.toLowerCase().replace(/^\./, '')
  if (TEXT_FILENAMES.has(base)) return 'text'
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  if (!ext) return null
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (TEXT_EXT.has(ext)) return 'text'
  return null
}
