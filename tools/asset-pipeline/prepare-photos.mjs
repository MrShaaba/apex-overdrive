#!/usr/bin/env node
/**
 * Family photos for the Fam Jam billboards.
 *
 * Reads every jpg/jpeg/png in a source folder (default assets-src/photos/fam-jam, which is
 * gitignored like the rest of assets-src), derives a caption from the file name
 * (underscores → spaces, extension dropped) when the name is human-readable — camera
 * export names such as 066A08BA-…_1_105_c.jpeg, IMG_1234 or 20240512_183022 get no caption,
 * so the board shows the photo alone — fits each photo into a 16:9 frame 1024 px wide and
 * writes web-friendly JPEGs plus a manifest to public/assets/photos/fam-jam/. A landscape
 * photo wider than 16:9 is cropped with sharp's attention strategy (skin tones and detail
 * decide the window, so faces stay in frame); a portrait, square or 4:3 photo is kept whole
 * and letterboxed — the bars are a blurred, darkened copy of the same photo rather than flat
 * black, so a phone portrait still fills the hoarding without anyone's head being cut off.
 *
 * Both folders are gitignored: the photos never enter the repository, and the game copes
 * with a missing or empty manifest by drawing blank boards (see Billboards.ts).
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
const SRC = path.resolve((args[0] ?? 'assets-src/photos/fam-jam').replace(/^~(?=$|\/)/, os.homedir()))
const BACKGROUND = { r: 14, g: 15, b: 20 }

/**
 * Is a file name something a person typed, rather than a camera or photo-library export?
 * Export names: UUIDs (066A08BA-2E9A-4187-…_1_105_c), IMG_/DSC_/PXL_/MVIMG_/PANO_/DJI_/GOPR…
 * followed by digits, date-time stamps (20240512_183022, 2024-05-12 18.30.22), bare hex or
 * digit runs, or names with hardly any letters in them.
 */
const isHumanReadable = (stem) => {
  const s = stem.trim()
  if (!s) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return false
  if (/^(IMG|IMAG|DSC|DSCN|DSCF|DCIM|PXL|MVIMG|PANO|VID|MOV|DJI|GOPR|GP|SAM|CIMG|P|PICT|SDC|_MG|_DSC|Screenshot|Screen Shot|Photo|Image|Picture|Untitled|Scan|Capture|FullSizeRender|Resized|Snapchat|WhatsApp Image|Facetune|Copy of )[\s_\-]*\d*[\s_\-]*(\(\d+\))?(_\w+)?$/i.test(s)) return false
  if (/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[\s_\-T]*\d{0,2}[-_.:]?\d{0,2}[-_.:]?\d{0,2}/.test(s) && !/[a-z]{3,}/i.test(s)) return false
  if (/^[0-9a-f\s_\-]+$/i.test(s) && /[0-9]/.test(s)) return false // hex / digit runs
  if (/[0-9a-f]{8,}/i.test(s.replace(/[^0-9a-z]/gi, ''))) return false // long hex run inside
  const letters = (s.match(/[a-z]/gi) ?? []).length
  const words = s.split(/[\s_\-]+/).filter((w) => /[a-z]{3,}/i.test(w))
  return words.length >= 1 && letters >= s.replace(/[\s_\-]/g, '').length * 0.5
}

/** Caption from a human-readable file name; empty for export names. */
const caption = (file) => {
  const stem = path.basename(file, path.extname(file))
  if (!isHumanReadable(stem)) return ''
  return stem
    .replace(/[_]+/g, ' ')
    .replace(/(?<=[a-z0-9])-(?=[a-z0-9])/gi, ' ') // beach-day-2024 reads as a phrase too
    .replace(/\s+/g, ' ')
    .trim()
}

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
    let fitted
    if (wide) {
      // Landscape wider than 16:9: scale the height to fit and crop the sides around the
      // region with the most skin tone and detail (faces), not blindly around the centre.
      fitted = image.resize({ width: WIDTH, height: HEIGHT, fit: 'cover', position: sharp.strategy.attention })
    } else {
      // Portrait / square / 4:3: the whole photo, scaled to fit, over a blurred and darkened
      // copy of itself filling the rest of the frame (a letterbox that is not flat black).
      const backdrop = await image.clone().resize({ width: WIDTH, height: HEIGHT, fit: 'cover', position: 'centre' }).blur(32).modulate({ brightness: 0.42, saturation: 0.75 }).toBuffer()
      const photo = await image.clone().resize({ width: WIDTH, height: HEIGHT, fit: 'inside', withoutEnlargement: false }).toBuffer()
      const pm = await sharp(photo).metadata()
      const left = Math.round((WIDTH - pm.width) / 2), top = Math.round((HEIGHT - pm.height) / 2)
      // A 3 px dark edge around the photo, clipped to the frame on the sides that touch it.
      const ex = Math.max(0, left - 3), ey = Math.max(0, top - 3)
      const ew = Math.min(WIDTH - ex, pm.width + 6), eh = Math.min(HEIGHT - ey, pm.height + 6)
      const edge = await sharp({ create: { width: ew, height: eh, channels: 3, background: BACKGROUND } }).png().toBuffer()
      fitted = sharp(backdrop).composite([{ input: edge, left: ex, top: ey }, { input: photo, left, top }])
    }
    let name = `${slug(file)}.jpg`
    for (let n = 2; usedNames.has(name); n++) name = `${slug(file)}-${n}.jpg`
    usedNames.add(name)
    await fitted.flatten({ background: BACKGROUND }).jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:2:0' }).toFile(path.join(OUT, name))
    const bytes = fs.statSync(path.join(OUT, name)).size
    const text = caption(file)
    photos.push({ file: name, caption: text, width: WIDTH, height: HEIGHT, source: file, bytes })
    console.log(`  ✓ ${file.padEnd(36)} ${String(meta.width).padStart(5)}×${String(meta.height).padEnd(5)} ${wide ? 'crop (attention)' : 'letterbox (blur fill)'} → ${name} (${(bytes / 1024).toFixed(0)} kB)  ${text ? `"${text}"` : '(no caption: export name)'}`)
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
if (skipped.length) console.log(`Skipped ${skipped.length} unreadable: ${skipped.map((s) => `${s.file} (${s.reason})`).join(', ')}`)
if (ignored.length) console.log(`Ignored ${ignored.length} non-image: ${ignored.join(', ')}`)
const captioned = photos.filter((p) => p.caption)
const uncaptioned = photos.filter((p) => !p.caption)
console.log(`Captions: ${captioned.length} from readable names${captioned.length ? ` (${captioned.map((p) => `${p.source} → "${p.caption}"`).join('; ')})` : ''}`)
console.log(`No caption: ${uncaptioned.length} camera/export names${uncaptioned.length ? ` (${uncaptioned.map((p) => p.source).join(', ')})` : ''} — rename a file to a phrase such as Beach_day_2024.jpg to caption it`)
console.log(`Manifest ${path.join(OUT, 'manifest.json')} (${manifest.photos.length} entries)`)
if (!photos.length) console.log('No photos processed — the Fam Jam track will show blank boards.')
