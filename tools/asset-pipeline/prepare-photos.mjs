#!/usr/bin/env node
/**
 * Family photos for the Fam Jam billboards.
 *
 * Reads every jpg/jpeg/png in a source folder (default ~/Downloads/fam-jam), derives a
 * caption from the file name (underscores → spaces, extension dropped), fits each photo
 * into a 16:9 frame 1024 px wide on a dark background (a landscape photo is centre-cropped
 * when it is wider than 16:9, a portrait or square one is letterboxed) and writes
 * web-friendly JPEGs plus a manifest to public/assets/photos/fam-jam/.
 *
 * The output folder is gitignored: the photos never enter the repository, and the game
 * copes with a missing or empty manifest by drawing blank boards (see Billboards.ts).
 *
 * Usage: node tools/asset-pipeline/prepare-photos.mjs [sourceDir] [--out <dir>] [--width 1024]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const OUT = path.resolve(flag('--out', 'public/assets/photos/fam-jam'))
const WIDTH = Math.max(256, Number(flag('--width', '1024')) || 1024)
const HEIGHT = Math.round((WIDTH * 9) / 16)
const SRC = path.resolve((args[0] ?? '~/Downloads/fam-jam').replace(/^~(?=$|\/)/, os.homedir()))
const BACKGROUND = { r: 14, g: 15, b: 20 }

const caption = (file) =>
  path
    .basename(file, path.extname(file))
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const slug = (file) =>
  path
    .basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'photo'

if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
  console.error(`Source folder not found: ${SRC}`)
  console.error('Put the family photos there (jpg/jpeg/png) or pass another folder as the first argument.')
  process.exit(1)
}

const entries = fs
  .readdirSync(SRC)
  .filter((f) => !f.startsWith('.'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
const candidates = entries.filter((f) => /\.(jpe?g|png)$/i.test(f))
const ignored = entries.filter((f) => !/\.(jpe?g|png)$/i.test(f))

fs.mkdirSync(OUT, { recursive: true })
const photos = []
const skipped = []
const usedNames = new Set()

for (const file of candidates) {
  const full = path.join(SRC, file)
  try {
    if (!fs.statSync(full).isFile()) throw new Error('not a file')
    const image = sharp(full, { failOn: 'error' }).rotate() // honour EXIF orientation
    const meta = await image.metadata()
    if (!meta.width || !meta.height) throw new Error('no dimensions')
    const wide = meta.width / meta.height >= 16 / 9
    // Landscape wider than 16:9: scale the height to fit and centre-crop the sides.
    // Portrait / square / narrower landscape: scale the width or height to fit and letterbox.
    const fitted = wide
      ? image.resize({ width: WIDTH, height: HEIGHT, fit: 'cover', position: 'centre' })
      : image.resize({ width: WIDTH, height: HEIGHT, fit: 'contain', background: BACKGROUND })
    let name = `${slug(file)}.jpg`
    for (let n = 2; usedNames.has(name); n++) name = `${slug(file)}-${n}.jpg`
    usedNames.add(name)
    await fitted.flatten({ background: BACKGROUND }).jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' }).toFile(path.join(OUT, name))
    const bytes = fs.statSync(path.join(OUT, name)).size
    photos.push({ file: name, caption: caption(file), width: WIDTH, height: HEIGHT, source: file, bytes })
    console.log(`  ✓ ${file.padEnd(36)} ${String(meta.width).padStart(5)}×${String(meta.height).padEnd(5)} ${wide ? 'crop' : 'letterbox'} → ${name} (${(bytes / 1024).toFixed(0)} kB)  "${caption(file)}"`)
  } catch (err) {
    skipped.push({ file, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) })
    console.log(`  ✗ ${file.padEnd(36)} skipped: ${skipped[skipped.length - 1].reason}`)
  }
}

// Remove stale outputs from a previous run so the manifest and the folder agree.
for (const f of fs.readdirSync(OUT)) {
  if (f === 'manifest.json' || usedNames.has(f)) continue
  if (/\.jpg$/i.test(f)) fs.unlinkSync(path.join(OUT, f))
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  frame: { width: WIDTH, height: HEIGHT },
  photos: photos.map(({ file, caption }) => ({ file, caption })),
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

console.log('')
console.log(`Source  ${SRC}`)
console.log(`Output  ${OUT}`)
console.log(`Processed ${photos.length} photo(s) into ${WIDTH}×${HEIGHT} JPEG (${(photos.reduce((s, p) => s + p.bytes, 0) / 1024).toFixed(0)} kB total)`)
if (skipped.length) console.log(`Skipped ${skipped.length} unreadable: ${skipped.map((s) => s.file).join(', ')}`)
if (ignored.length) console.log(`Ignored ${ignored.length} non-image: ${ignored.join(', ')}`)
console.log(`Manifest ${path.join(OUT, 'manifest.json')} (${manifest.photos.length} entries)`)
if (!photos.length) console.log('No photos processed — the Fam Jam track will show blank boards.')
