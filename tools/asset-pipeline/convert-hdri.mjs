#!/usr/bin/env node
/**
 * Converts a raw OpenEXR panorama (assets-src/hdri/*.exr) into a compact
 * Radiance RGBE (.hdr) file under public/assets/hdri for the runtime
 * RGBELoader → PMREM environment in render/Sky.ts.
 *
 * Usage: node tools/asset-pipeline/convert-hdri.mjs <in.exr> <out.hdr> [width]
 *
 * - Decodes with three's EXRLoader (pure JS, handles PIZ/ZIP/RLE) so no native
 *   image tools are needed.
 * - Box-filters down to `width` × `width/2` (default 2048 × 1024).
 * - Writes RLE-compressed RGBE scanlines (top row first, as the format expects).
 * - Prints the sun direction (brightest texel) as an equirect longitude so the
 *   runtime can rotate the environment to match the procedural sun.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

const [inPath, outPath, widthArg] = process.argv.slice(2)
if (!inPath || !outPath) {
  console.error('usage: convert-hdri.mjs <in.exr> <out.hdr> [width]')
  process.exit(2)
}
const outW = Number(widthArg ?? 2048)
const outH = outW / 2

const t0 = Date.now()
const buf = fs.readFileSync(inPath)
const loader = new EXRLoader()
loader.setDataType(THREE.FloatType)
const exr = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const ch = exr.data.length / (exr.width * exr.height)
console.log(`decoded ${exr.width}×${exr.height} (${ch} ch) in ${Date.now() - t0} ms`)

// three's EXRLoader stores row 0 at the *bottom* of the image (flipY=false
// texture convention). Radiance files store the top row first, so flip here.
const sx = exr.width / outW
const sy = exr.height / outH
if (!Number.isInteger(sx) || !Number.isInteger(sy)) throw new Error(`output size must divide source size (got ${sx}×${sy})`)
const out = new Float32Array(outW * outH * 3)
for (let oy = 0; oy < outH; oy++) {
  for (let ox = 0; ox < outW; ox++) {
    let r = 0, g = 0, b = 0
    for (let dy = 0; dy < sy; dy++) {
      const srcRow = exr.height - 1 - (oy * sy + dy) // flip
      for (let dx = 0; dx < sx; dx++) {
        const i = (srcRow * exr.width + ox * sx + dx) * ch
        r += exr.data[i]
        g += exr.data[i + 1]
        b += exr.data[i + 2]
      }
    }
    const n = sx * sy
    const o = (oy * outW + ox) * 3
    out[o] = r / n
    out[o + 1] = g / n
    out[o + 2] = b / n
  }
}

// Sun: brightest texel of the downsampled image.
let best = -1, bx = 0, by = 0, sum = 0
for (let i = 0; i < outW * outH; i++) {
  const l = out[i * 3] + out[i * 3 + 1] + out[i * 3 + 2]
  sum += l
  if (l > best) { best = l; bx = i % outW; by = Math.floor(i / outW) }
}
const sunU = bx / outW
const sunV = 1 - by / outH // 1 = zenith
console.log(`mean luminance ${(sum / (outW * outH) / 3).toFixed(3)}, sun texel (${bx},${by}) u=${sunU.toFixed(3)} v=${sunV.toFixed(3)} → elevation ${((sunV - 0.5) * 180).toFixed(1)}°, longitude ${((sunU - 0.5) * 360).toFixed(1)}°`)

// --- RGBE encode with new-style RLE scanlines ---
function toRGBE(r, g, b) {
  const m = Math.max(r, g, b)
  if (m < 1e-32) return [0, 0, 0, 0]
  const e = Math.ceil(Math.log2(m)) // m ∈ (2^(e-1), 2^e]
  const scale = 256 / Math.pow(2, e)
  return [Math.min(255, Math.floor(r * scale)), Math.min(255, Math.floor(g * scale)), Math.min(255, Math.floor(b * scale)), e + 128]
}
function rleChannel(bytes, push) {
  // Radiance RLE: runs of identical bytes (len 4..127) as [128+len, byte]; literal blocks (len 1..128) as [len, ...bytes].
  let i = 0
  const n = bytes.length
  while (i < n) {
    let run = 1
    while (i + run < n && run < 127 && bytes[i + run] === bytes[i]) run++
    if (run >= 4) {
      push(128 + run)
      push(bytes[i])
      i += run
      continue
    }
    let j = i
    while (j < n && j - i < 128) {
      let r2 = 1
      while (j + r2 < n && r2 < 4 && bytes[j + r2] === bytes[j]) r2++
      if (r2 >= 4) break
      j++
    }
    push(j - i)
    for (let k = i; k < j; k++) push(bytes[k])
    i = j
  }
}
const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=apex convert-hdri\n\n-Y ${outH} +X ${outW}\n`
const chunks = [Buffer.from(header, 'latin1')]
const line = new Uint8Array(outW * 4)
for (let y = 0; y < outH; y++) {
  for (let x = 0; x < outW; x++) {
    const o = (y * outW + x) * 3
    const [r, g, b, e] = toRGBE(out[o], out[o + 1], out[o + 2])
    line[x] = r
    line[outW + x] = g
    line[outW * 2 + x] = b
    line[outW * 3 + x] = e
  }
  const bytes = [2, 2, (outW >> 8) & 0xff, outW & 0xff]
  for (let c = 0; c < 4; c++) rleChannel(line.subarray(c * outW, (c + 1) * outW), (v) => bytes.push(v))
  chunks.push(Buffer.from(bytes))
}
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, Buffer.concat(chunks))
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB) in ${Date.now() - t0} ms`)
