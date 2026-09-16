// Reading a PNG's alpha channel without a dependency.
//
// The whole point of these files is the transparency, and transparency is the
// one thing a rendered thumbnail cannot show — a viewer composites it over
// white and a fully opaque rectangle looks identical to a correctly cut one.
// So the capture is checked by reading pixels: the outer corner must be clear,
// the middle must be solid, and the shadow must be somewhere in between.
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const paeth = (a, b, c) => {
  const pa = Math.abs(b - c)
  const pb = Math.abs(a - c)
  const pc = Math.abs(a + b - 2 * c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decode a non-interlaced 8-bit RGB/RGBA PNG to flat bytes. */
export const readPng = (path) => {
  const file = readFileSync(path)
  let offset = 8
  let width = 0
  let height = 0
  let colourType = 0
  const parts = []
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const data = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colourType = data[9]
      if (data[8] !== 8) throw new Error(`${path}: only 8-bit PNGs are read here`)
      if (data[12] !== 0) throw new Error(`${path}: interlaced PNGs are not read here`)
    }
    if (type === 'IDAT') parts.push(data)
    offset += 12 + length
  }
  const channels = colourType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(parts))
  const pixels = Buffer.alloc(stride * height)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = pixels.subarray(y * stride, (y + 1) * stride)
    raw.copy(line, 0, cursor, cursor + stride)
    cursor += stride
    const above = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = above ? above[x] : 0
      const upLeft = above && x >= channels ? above[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + left) & 0xff
      else if (filter === 2) line[x] = (line[x] + up) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) line[x] = (line[x] + paeth(left, up, upLeft)) & 0xff
    }
  }
  return {
    at: (x, y) => {
      const start = (y * width + x) * channels
      return {
        a: channels === 4 ? pixels[start + 3] : 255,
        b: pixels[start + 2],
        g: pixels[start + 1],
        r: pixels[start],
      }
    },
    channels,
    height,
    width,
  }
}

/**
 * What a correct cut-out looks like, stated as pixels rather than as a claim:
 * the extreme corner is clear, the middle is solid, and — when the shot was
 * padded for one — a shadow sits partly transparent in the margin.
 */
export const assertRounded = (path, { pad, shadow = true }) => {
  const png = readPng(path)
  if (png.channels !== 4) throw new Error(`${path} has no alpha channel`)
  const corner = png.at(1, 1)
  if (corner.a !== 0) throw new Error(`${path}: the outer corner is opaque (alpha ${corner.a}), so the background was not omitted`)
  const middle = png.at(Math.floor(png.width / 2), Math.floor(png.height / 2))
  if (middle.a < 250) throw new Error(`${path}: the middle is transparent (alpha ${middle.a}), so the element itself did not paint`)

  // The radius has to be in the file, not only in the CSS that made it: a
  // pixel just inside the padding but still outside the rounded edge is the
  // one that proves it. Sampled on the diagonal, where a square corner would
  // be solid.
  if (pad != null) {
    const device = png.width / (png.width / 2) >= 2 ? 2 : 1
    const inset = Math.round((pad + 3) * device)
    const cut = png.at(inset, inset)
    if (cut.a === 255) throw new Error(`${path}: the corner at ${inset}px is fully opaque, so the radius was not baked in`)
    if (shadow) {
      const margin = png.at(Math.floor(png.width / 2), Math.round(pad * device * 0.5))
      if (margin.a === 0) throw new Error(`${path}: nothing is painted in the shadow margin above the element`)
    }
  }
  return png
}
