// Renders a .hdr panorama to a small tone-mapped PPM for eyeballing orientation/exposure.
// Usage: node tools/asset-pipeline/preview-hdri.mjs <in.hdr> <out.ppm> [exposure]
import fs from 'node:fs'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import * as THREE from 'three'
const buf = fs.readFileSync(process.argv[2])
const l = new RGBELoader(); l.setDataType(THREE.FloatType)
const r = l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const ch = r.data.length / (r.width * r.height)
console.log('hdr', r.width, r.height, 'ch', ch, 'flipY?', r.flipY)
const W = 512, H = 256, sx = r.width / W, sy = r.height / H
const rowLum = (y) => { let s = 0; for (let x = 0; x < r.width; x++) { const i = (y * r.width + x) * ch; s += 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2] } return (s / r.width).toFixed(3) }
console.log('file row0 (should be image top/zenith)', rowLum(0), 'row 1/4', rowLum(r.height / 4 | 0), 'horizon', rowLum(r.height / 2 | 0), 'row 3/4', rowLum(r.height * 3 / 4 | 0), 'last', rowLum(r.height - 1))
const out = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let c = [0, 0, 0]
  for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) { const i = ((y * sy + dy) * r.width + x * sx + dx) * ch; c[0] += r.data[i]; c[1] += r.data[i + 1]; c[2] += r.data[i + 2] }
  for (let k = 0; k < 3; k++) { const v = c[k] / (sx * sy) * Number(process.argv[4] ?? 1); out[(y * W + x) * 3 + k] = Math.round(255 * Math.pow(v / (1 + v), 1 / 2.2)) }
}
fs.writeFileSync(process.argv[3], Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), out]))
