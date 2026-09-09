// Render a prepare-track --map dump: road triangles grey, skeleton cells red, line yellow.
import fs from 'node:fs'
import sharp from 'sharp'
const [file, out, W = '1400', crop] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(file, 'utf8'))
let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
for (const t of j.road) for (const p of t) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])] }
if (crop) { const c = crop.split(',').map(Number); lo = [c[0], c[1]]; hi = [c[2], c[3]] }
const S = Number(W) / (hi[0] - lo[0]), H = Math.ceil((hi[1] - lo[1]) * S)
const X = (x) => ((x - lo[0]) * S).toFixed(1), Z = (z) => ((z - lo[1]) * S).toFixed(1)
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#eef"/>`
svg += `<g fill="#999" stroke="#999" stroke-width="0.3">` + j.road.map((t) => `<polygon points="${t.map((p) => X(p[0]) + ',' + Z(p[1])).join(' ')}"/>`).join('') + '</g>'
if (j.pit) svg += `<g fill="#39f">` + j.pit.map((p) => `<circle cx="${X(p[0])}" cy="${Z(p[1])}" r="1"/>`).join('') + '</g>'
svg += `<g fill="#d00">` + j.skeleton.map((p) => `<circle cx="${X(p[0])}" cy="${Z(p[1])}" r="${Math.max(1, S * 0.6)}"/>`).join('') + '</g>'
if (j.walls) svg += `<g fill="#000">` + j.walls.filter((_, i) => i % 3 === 0).map((p) => `<circle cx="${X(p[0])}" cy="${Z(p[1])}" r="0.8"/>`).join('') + '</g>'
svg += `<polyline fill="none" stroke="#fc0" stroke-width="2" points="${j.line.map((p) => X(p[0]) + ',' + Z(p[1])).join(' ')}"/>`
svg += `<text x="10" y="24" font-size="18">x ${lo[0].toFixed(0)}..${hi[0].toFixed(0)} z ${lo[1].toFixed(0)}..${hi[1].toFixed(0)} skeleton ${j.skeleton.length} cells</text></svg>`
await sharp(Buffer.from(svg)).png().toFile(out)
console.log(out)
