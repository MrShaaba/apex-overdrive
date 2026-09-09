#!/usr/bin/env node
/**
 * Turns a raw circuit model (assets-src/models/tracks/<name>/scene.gltf)
 * into a game-ready .glb under public/assets/models/tracks and derives the
 * lap centreline the game's TrackSpline needs.
 *
 *  1. bakes every node transform (plus scale/yaw) into the vertices and
 *     classifies primitives with the track's `rules` (regex on node path or
 *     material name, first match wins) into road / kerb / pit / gravel /
 *     terrain / wall / overlay / prop; the runtime maps those names to
 *     colliders and surfaces (overlay and prop get none);
 *  2. derives the centreline from the lap surface: the core road (+ kerbs) is
 *     rasterised (1–2 m cells; `res` overrides; `coreRadius` lets general
 *     asphalt within that distance of the core rules join it, for models whose
 *     track shares a material with paddocks and car parks), the non-road cells
 *     reachable from the border are the outside and the largest enclosed region
 *     is the infield, and the road cells equidistant from both are the lap
 *     band — paddocks, pit lanes and access roads never separate infield from
 *     outside, so they drop out; the band is thinned, its few junctions
 *     resolved by the largest-area cycle, then re-centred across the full road;
 *  3. samples the road height under every point, orients the loop in the
 *     circuit's real direction (`direction`, as seen from above), starts it at
 *     the model's start marker (`startMarker`: start lights, gantry, painted
 *     line), else beside the pit lane, else on the longest straight; derives
 *     the pit-lane zone from the pit asphalt nearest the start, and writes
 *     control points + features to `pointsOut`;
 *  4. decimates the heavy classes (per primitive, never the lap surface),
 *     encodes textures to KTX2 and Draco-compresses the geometry.
 *
 * Nothing about the route is authored: if a road surface does not yield a
 * clean lap the script says so and stops. `map-track.mjs` draws the material
 * groups and the generated centreline for checking a config.
 *
 * Usage: node tools/asset-pipeline/prepare-track.mjs <track-id> [--skip-textures] [--points-only] [--map]
 *   --points-only rewrites the centreline JSON without touching the .glb; --map dumps
 *   the raster, skeleton, wall cells and per-point width walks to $TMPDIR/<id>-centreline.json;
 *   DEBUG_WALK=x,z prints the raster cells across the road at that world position.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import { dedup, draco, joinPrimitives, listTextureSlots, prune, simplifyPrimitive, textureCompress, transformPrimitive, weld, weldPrimitive } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const CLASSES = ['road', 'kerb', 'pit', 'runoff', 'gravel', 'terrain', 'wall', 'overlay', 'prop']

const TRACKS = {
  drift: {
    source: 'assets-src/models/tracks/drift_race_track/scene.gltf',
    output: 'public/assets/models/tracks/drift.glb',
    pointsOut: 'src/game/tracks/data/drift.points.json',
    credit: 'Drift Race Track Free by Nicholas-3D (sketchfab.com/Nicholas01), CC-BY-ND 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw', // seen from above in three's frame; Drift Park has no inherent direction, this keeps its data stable
    tracer: 'skeleton',
    rules: [
      { cls: 'road', path: /\/Road/ },
      { cls: 'terrain', path: /\/Terrain/ },
      { cls: 'wall', path: /\/Barrier|\/Rails/ },
    ],
    decimate: { wall: 0.35 },
    materials: [{ match: /Leaf/i, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }],
    textures: { color: 2048, normal: 1024, other: 1024 },
    controlSpacing: 14,
  },
  bugatti: {
    source: 'assets-src/models/tracks/bugatti_circuit_2017_layout/scene.gltf',
    output: 'public/assets/models/tracks/bugatti.glb',
    pointsOut: 'src/game/tracks/data/bugatti.points.json',
    credit: 'Bugatti Circuit 2017 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    controlSpacing: 10,
    res: 1, // the edge-line strips are under 2 m wide
    coreRadius: 9,
    coreClose: 4,
    startMarker: /^podium/, // the podium sits on the pit building at the start line
    rules: [
      { cls: 'road', material: /^ROADTSTRIPE/ }, // the track's edge-line strips seed the lap
      { cls: 'road', material: /^01_-_Default|^09_-_Defaultfeu|^TRANSIT|^ROADREAL|^pass/, lap: 'near' }, // the asphalt: track, pit lane, paddock and car parks share it; TRANSIT and ROADREAL* are tarmac variants of some stretches; pass* is the Dunlop bridge deck
      { cls: 'kerb', material: /^ROADKERB/ },
      { cls: 'pit', material: /^ROAD_02/ },
      { cls: 'overlay', material: /^04_-_Default|^08_-_Default/ },
      { cls: 'terrain', material: /^GRASS|^BACKGRD/ },
      { cls: 'wall', material: /^TYREW|^GUARD|^WALL_|^WALLSPON|^BLOCKS|^FENCE_|^FPOLE/ },
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /trees|pines|TREE|GRASS|BACKGRD|TRANSIT|FPOLE|CORNERWORKER|cameraman|TEAMMEMBERS|GSSEATS|EQUIP|^CARS|RUBBER|FENCE/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  hungaroring: {
    source: 'assets-src/models/tracks/hungaroring_2020_layout/scene.gltf',
    output: 'public/assets/models/tracks/hungaroring.glb',
    pointsOut: 'src/game/tracks/data/hungaroring.points.json',
    credit: 'Hungaroring 2020 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    controlSpacing: 10,
    startMarker: /_15$/, // the pit wall along the main straight (the light panels are scattered marshal lights)
    // A ripped export: material names are numbers, read off the texture contact sheet.
    rules: [
      { cls: 'road', material: /_76$/ }, // the track surface, with its asphalt run-off aprons
      { cls: 'road', material: /_14$|_75$/, lap: 'near' }, // shoulders, pit lane, paddock; light asphalt run-off
      { cls: 'kerb', material: /_2$|_0$|_1$/ },
      { cls: 'runoff', material: /_36$/ }, // concrete run-off
      { cls: 'overlay', material: /_56$|_11$|_10$|_90$|_12$/ }, // edge lines, skid marks, pit markings
      { cls: 'terrain', material: /^Merged_materials|_3$|_4$|_18$|_13$|_73$/ }, // grass, the aerial backdrop, dirt roads
      { cls: 'wall', material: /_8$|_21$|_53$|_6$|_15$|_45$|_7$/ }, // armco, concrete and stone walls, posts, pit wall, barrier covers
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /_77$|^Merged_materials|_3$|_4$|_18$|_13$|_73$|_84$|_39$|_40$|_79$|_80$|_96$|_58$|_23$|_25$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  // Skipped (2026-09-09): at the start/finish the pit-exit tunnel road and the track share
  // material tentrail_32 and overlap in plan, the track surface is missing at the line and the
  // traced line drops into the tunnel; the rest of the lap traces (5339 m at 1.926 scale).
  yas: {
    source: 'assets-src/models/tracks/yas_marina_circuit_abu_dhabi_2021_layout/scene.gltf',
    output: 'public/assets/models/tracks/yas.glb',
    pointsOut: 'src/game/tracks/data/yas.points.json',
    credit: 'Yas Marina Circuit Abu Dhabi 2021 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1.926, // the export is ~52 % size: 2742 m traced at 1:1 against the real 5281 m lap
    yawDeg: 0,
    direction: 'ccw',
    controlSpacing: 10,
    tracer: 'skeleton', // the band method locks onto a thin pocket between the parallel straights
    startMarker: /tentrail_45$/, // an 8 m cube with the start-gantry light board texture
    // A ripped export: material names are numbers, read off the texture contact sheet and material mini-maps.
    rules: [
      { cls: 'road', material: /tentrail_32$/ }, // the track
      // tentrail_19, _28, _29 and _58 are decks and roofs 3–5 m above the track around the pits, not run-off: props
      { cls: 'kerb', material: /tentrail_21$|tentrail_20$|tentrail_66$/ },
      // tentrail_31 (blue) and _34 (white) looked like painted run-off but are 5–8 m tall cladding: props
      { cls: 'overlay', material: /tentrail_30$|tentrail_87$|tentrail_16$/ }, // edge lines, skid marks, markings
      { cls: 'gravel', material: /tentrail_11$|tentrail_26$/ }, // sand
      { cls: 'terrain', material: /tentrail_69$|tentrail_25$/ },
      { cls: 'wall', material: /tentrail_17$|tentrail_46$|tentrail_73$/ }, // barriers, fence posts, catch fencing
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /tentrail_57$|^Merged_materials|tentrail_89$|tentrail_86$|tentrail_69$|tentrail_25$|tentrail_11$|tentrail_26$|tentrail_72$|tentrail_73$|tentrail_75$|tentrail_42$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  shanghai: {
    source: 'assets-src/models/tracks/shanghai_international_circuit_2018_layout/scene.gltf',
    output: 'public/assets/models/tracks/shanghai.glb',
    pointsOut: 'src/game/tracks/data/shanghai.points.json',
    credit: 'Shanghai International Circuit 2018 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    controlSpacing: 10,
    tracer: 'skeleton', // the short-circuit link road splits the infield; the largest cycle is the GP lap
    // A ripped export whose materials are all called advert_side_a_N: read off flatmats.mjs,
    // matmaps.mjs and the texture sheet.
    rules: [
      { cls: 'road', material: /advert_side_a_22$/ }, // the track
      { cls: 'pit', material: /advert_side_a_23$/ }, // pit lane concrete
      { cls: 'kerb', material: /advert_side_a_12$/ },
      { cls: 'runoff', material: /advert_side_a_13$|advert_side_a_86$|advert_side_a_14$/ }, // light concrete run-off, rubbered asphalt run-off, paddock floor
      { cls: 'gravel', material: /advert_side_a_81$|advert_side_a_80$/ },
      { cls: 'terrain', material: /advert_side_a_82$|advert_side_a_79$|advert_side_a_11$|advert_side_a_15$|advert_side_a_19$|advert_side_a_29$/ }, // grass, verges, lakes
      { cls: 'overlay', material: /advert_side_a_66$|advert_side_a_77$|advert_side_a_62$|advert_side_a_61$|advert_side_a_65$|advert_side_a_64$/ }, // edge shadows, lines, strips, decals
      { cls: 'wall', material: /advert_side_a_48$|advert_side_a_44$|advert_side_a_17$|advert_side_a_37$|advert_side_a_50$|advert_side_a_68$|advert_side_a_88$|advert_side_a_96$|advert_side_a_76$|advert_side_a_56$|advert_side_a_58$|advert_side_a_16$/ }, // tyre stacks, fence posts, armco, concrete walls, pit wall, catch fencing, railings
    ],
    // The tyre stacks (_9) are 724k triangles of separate little shells that no simplifier
    // can collapse; they stay scenery (the armco and fences behind them are the walls).
    decimate: { wall: 0.3, prop: 0.35, terrain: 0.7 },
    noShadow: /advert_side_a_82$|advert_side_a_79$|advert_side_a_11$|advert_side_a_15$|advert_side_a_19$|advert_side_a_29$|advert_side_a_66$|advert_side_a_64$|advert_side_a_65$|advert_side_a_9$|advert_side_a_81$|advert_side_a_80$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  marina: {
    source: 'assets-src/models/tracks/marina_bay_street_circuit/scene.gltf',
    output: 'public/assets/models/tracks/marina.glb',
    pointsOut: 'src/game/tracks/data/marina.points.json',
    credit: 'Marina Bay Street Circuit by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'ccw',
    controlSpacing: 10,
    tracer: 'skeleton',
    res: 1,
    // Street circuit: the track is one asphalt material threading a city of a hundred
    // building materials; barriers are concrete blocks with light rigs on top.
    rules: [
      { cls: 'road', material: /^11001Mtl_14$/ }, // the road surface (lane sheet; also the flyover deck)
      { cls: 'road', material: /^11001Mtl_15$/, lap: 'near' }, // asphalt edge strips either side
      { cls: 'runoff', material: /^11001Mtl_96$/ }, // pavements and service asphalt beside the track
      { cls: 'overlay', material: /^11001Mtl_92$|^11001Mtl_3$/ }, // edge shadows, paving grid
      { cls: 'terrain', material: /^11001Mtl$|^11001Mtl_94$|^11001Mtl_95$/ }, // sea, city ground, grass
      { cls: 'wall', material: /^11001Mtl_76$|^11001Mtl_18$|^11001Mtl_71$|^11001Mtl_72$|^11001Mtl_73$|^11001Mtl_93$|^11001Mtl_74$|^11001Mtl_75$/ }, // concrete barriers with light rigs, barrier blocks, catch fences, fence screens
    ],
    decimate: { wall: 0.4, prop: 0.4, terrain: 0.5 },
    noShadow: /^11001Mtl$|^11001Mtl_94$|^11001Mtl_95$|^11001Mtl_92$|^11001Mtl_3$|^11001Mtl_14$|^11001Mtl_93$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  suzuka: {
    source: 'assets-src/models/tracks/suzuka_circuit_2001_layout/scene.gltf',
    output: 'public/assets/models/tracks/suzuka.glb',
    pointsOut: 'src/game/tracks/data/suzuka.points.json',
    credit: 'Suzuka Circuit 2001 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    controlSpacing: 10,
    tracer: 'skeleton',
    res: 1,
    coreClose: 3, // the pit-straight surface is stitched from strips that leave slits at 1 m
    crossings: [[-138, -164]], // the figure-eight overpass: pass straight through, twice
    rules: [
      { cls: 'road', material: /^282_69$|^282_68$|^282_66$/ }, // the track (edge lines baked in), the pit-straight surface, and pieces shared with the East/West link roads
      { cls: 'pit', material: /^282_64$/ }, // pit lane with its bay markings
      { cls: 'kerb', material: /^282_10$/ },
      { cls: 'runoff', material: /^282_65$|^282_3$|^282_59$/ }, // paddock asphalt, pit apron, concrete run-off
      { cls: 'overlay', material: /^282_94$|^282_92$|^282_28$|^282_93$|^282_61$/ }, // groove, skid marks, decals, edge strips
      { cls: 'terrain', material: /^282_60$|^282_62$|^282_57$|^282_58$|^282_56$|^material$|^282_29$/ }, // grass, verges, lake, hills
      { cls: 'wall', material: /^282_6$|^282_1$|^282_96$|^282_85$|^282_7$|^282_8$|^282_41$|^282_73$|^282_74$|^282_37$|^282_90$/ }, // tyre stacks, concrete walls, catch fences, armco, blocks, screens
    ],
    decimate: { wall: 0.5, prop: 0.5, terrain: 0.7 },
    noShadow: /^282_60$|^282_62$|^282_57$|^282_58$|^282_56$|^material$|^282_29$|^282_94$|^282_92$|^282_28$|^282_93$|^282_61$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  indianapolis: {
    source: 'assets-src/models/tracks/indianapolis_motor_speedway/scene.gltf',
    output: 'public/assets/models/tracks/indianapolis.glb',
    pointsOut: 'src/game/tracks/data/indianapolis.points.json',
    credit: 'Indianapolis Motor Speedway by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'ccw',
    controlSpacing: 10,
    startMarker: /standard_20\.004_50$/, // the pit garages along the front straight
    // The oval is the lap; the infield road course stays drivable asphalt but is not traced
    // (the largest cycle is the oval anyway).
    rules: [
      { cls: 'road', material: /standard_20\.004_9$/ }, // the oval
      { cls: 'road', material: /standard_20\.004_16$|standard_20\.004_7$/, lap: 'near' }, // infield road course
      { cls: 'runoff', material: /standard_20\.004_10$/ }, // cracked concrete aprons
      { cls: 'gravel', material: /standard_20\.004_34$/ },
      { cls: 'terrain', material: /standard_20\.004_31$|standard_20\.004_90$|standard_20\.004_30$|standard_20\.004_13$/ }, // infield grass, surroundings, verge strips
      { cls: 'overlay', material: /standard_20\.004_8$|standard_20\.004_22$/ }, // edge lines, drains
      { cls: 'wall', material: /standard_20\.004_89$|standard_20\.004_46$|standard_20\.004_37$|standard_20\.004_43$|standard_20\.004_67$|standard_20\.004_38$/ }, // armco, SAFER walls, catch fences, tyre stacks (the chevron blocks at the road-course merges stay scenery: they reach onto the oval)
    ],
    decimate: { wall: 0.3, prop: 0.4, terrain: 0.5 },
    noShadow: /standard_20\.004_31$|standard_20\.004_90$|standard_20\.004_30$|standard_20\.004_13$|standard_20\.004_8$|standard_20\.004_22$|standard_20\.004_65$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  sepang: {
    source: 'assets-src/models/tracks/sepang_international_circuit_2025_layout/scene.gltf',
    output: 'public/assets/models/tracks/sepang.glb',
    pointsOut: 'src/game/tracks/data/sepang.points.json',
    credit: 'Sepang International Circuit 2025 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1, // the full lap traces at 5533 m against the real 5543 m
    yawDeg: 0,
    direction: 'cw',
    controlSpacing: 10,
    startMarker: /Sepang691Mtl_50$/, // the checkered start-line block
    tracer: 'skeleton', // two lobes joined by parallel straights: the band picks one lobe, the largest cycle is the lap
    res: 1, // half-widths to ±0.5 m: at 2 m the AI line sat on T7's inside kerb
    // A ripped export: material names are numbers, read off the texture contact sheet and material mini-maps.
    rules: [
      { cls: 'road', material: /Sepang691Mtl_22$/ }, // the track
      { cls: 'road', material: /Sepang691Mtl_70$|Sepang691Mtl_97$/, lap: 'near' }, // asphalt run-off
      { cls: 'pit', material: /Sepang691Mtl$|Sepang691Mtl_1$/ }, // concrete pit lane + blue pit-box floors along the main straight
      { cls: 'kerb', material: /Sepang691Mtl_90$|Sepang691Mtl_54$/ },
      { cls: 'runoff', material: /Sepang691Mtl_57$|Sepang691Mtl_82$|Sepang691Mtl_2$|Sepang691Mtl_96$|Sepang691Mtl_81$|Sepang691Mtl_91$|Sepang691Mtl_89$|Sepang691Mtl_84$/ }, // painted run-off, the service strip beside the back straight, coloured paint areas, ground-painted sponsor logos and boards, concrete pads, the grass-textured hump strips that cross T1's asphalt
      { cls: 'drop', material: /Sepang691Mtl_5$/ }, // circuit-wide alpha-0 mesh (invisible)
      { cls: 'overlay', material: /Sepang691Mtl_83$|Sepang691Mtl_85$|Sepang691Mtl_20$|Sepang691Mtl_87$|Sepang691Mtl_19$|Sepang691Mtl_86$/ }, // edge strips, skid marks, markings, sponsor decals, shadow gradients
      { cls: 'gravel', material: /Sepang691Mtl_6$/ },
      { cls: 'terrain', material: /Sepang691Mtl_0$|Sepang691Mtl_71$|Sepang691Mtl_95$|Sepang691Mtl_94$/ }, // grass, dirt, pavers
      { cls: 'wall', material: /Sepang691Mtl_39$|Sepang691Mtl_56$|Sepang691Mtl_41$|Sepang691Mtl_40$|Sepang691Mtl_8$|Sepang691Mtl_80$|Sepang691Mtl_72$/ }, // armco, concrete walls, posts, tyre barriers, catch fencing, pit wall, concrete retaining walls
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /Sepang691Mtl_21$|Sepang691Mtl_0$|Sepang691Mtl_71$|Sepang691Mtl_95$|Sepang691Mtl_94$|Sepang691Mtl_6$|Sepang691Mtl_8$|Sepang691Mtl_3$|Sepang691Mtl_16$|Sepang691Mtl_14$|Sepang691Mtl_7$|Sepang691Mtl_86$|Sepang691Mtl_80$/,
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  spa: {
    source: 'assets-src/models/tracks/circuit_de_spa-francorchamps_2022_layout/scene.gltf',
    output: 'public/assets/models/tracks/spa.glb',
    pointsOut: 'src/game/tracks/data/spa.points.json',
    credit: 'Circuit de Spa-Francorchamps 2022 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    startMarker: /start-lights/, // the start line sits under the model's start-light gantry
    rules: [
      { cls: 'road', material: /^asph_new|^asph_patch|^groove/ }, // the racing-groove meshes are the lap surface
      { cls: 'road', material: /^asph\./, lap: 'near' }, // general asphalt: the road's full width (plus aprons, pit exit, service roads) — widens the line, never traces it
      { cls: 'kerb', material: /^kerb|^CURB/ },
      { cls: 'pit', material: /pitlane|^asph-grv/ },
      { cls: 'runoff', material: /^carpet|^grilles/ }, // painted run-off areas; drain grilles lie flush in the road
      { cls: 'overlay', material: /^line\.|^new_AO/ },
      { cls: 'gravel', material: /^sand/ },
      { cls: 'terrain', material: /grass|^GRASS|sbancamento|construction_dirt|^Parking|road-ext|^top-ext|^water/ },
      { cls: 'wall', material: /^grails|^barriers|^jersey|^walls|concrete-barrie|^fences|fence-special|stone-wall|ivy-wall/ },
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /trees|treesline|grass|^GRASS|top-ext|road-ext|sand|water|Parking/,
    textures: { color: 2048, normal: 1024, other: 1024 },
    controlSpacing: 10,
  },
}

const [trackId, ...flags] = process.argv.slice(2)
const cfg = TRACKS[trackId]
if (!cfg) {
  console.error(`unknown track "${trackId}". Known: ${Object.keys(TRACKS).join(', ')}`)
  process.exit(2)
}
const skipTextures = flags.includes('--skip-textures')
// POINTS_OUT=path writes the centreline elsewhere (e.g. while the dev server is busy).
const pointsOutPath = process.env.POINTS_OUT ?? cfg.pointsOut
const outputPath = process.env.OUTPUT_GLB ?? cfg.output // OUTPUT_GLB=path builds elsewhere
const pointsOnly = flags.includes('--points-only') // recompute the centreline data without touching the .glb
const t0 = Date.now()

// --- helpers ---------------------------------------------------------------------
const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o }
const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const yawM = (rad) => [Math.cos(rad), 0, -Math.sin(rad), 0, 0, 1, 0, 0, Math.sin(rad), 0, Math.cos(rad), 0, 0, 0, 0, 1]
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]

// --- collect + bake + classify ------------------------------------------------------
const prims = []
function walk(node, parentPath) {
  const pathStr = `${parentPath}/${node.getName()}`
  const mesh = node.getMesh()
  if (mesh) {
    const world = Array.from(node.getWorldMatrix())
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? ''
      const rule = cfg.rules.find((r) => (r.path && r.path.test(pathStr)) || (r.material && r.material.test(matName)))
      const cls = rule ? rule.cls : 'prop'
      if (cls === 'drop') continue // invisible collision/helper meshes in the export
      if (!CLASSES.includes(cls)) throw new Error(`bad class ${cls}`)
      prims.push({ prim, cls, pathStr, matName, world, lap: rule?.lap === undefined ? true : rule.lap, noShadow: !!(cfg.noShadow && (cfg.noShadow.test(matName) || cfg.noShadow.test(pathStr))) })
    }
  }
  for (const c of node.listChildren()) walk(c, pathStr)
}
for (const c of scene.listChildren()) walk(c, '')
const R = mul(yawM((cfg.yawDeg * Math.PI) / 180), scaleM(cfg.scale))
for (const p of prims) transformPrimitive(p.prim, mul(R, p.world))
const counts = {}
for (const p of prims) counts[p.cls] = (counts[p.cls] || 0) + 1
console.log('primitives by class:', JSON.stringify(counts))

// --- lap surface → raster → skeleton → graph → largest cycle ----------------------------
// Lap surface: `lap: true` prims (the racing groove, kerbs) give the lap its
// topology — they exist only on the track, so run-off aprons, the pit exit and
// service roads never join the skeleton. `lap: 'near'` prims (general asphalt)
// carry the road's real width: after the skeleton is traced, every point is
// re-centred across core + near asphalt, stopping at walls, so the line sits in
// the middle of the road rather than on the rubbered racing line.
const lapPrims = prims.filter((p) => (p.cls === 'road' || p.cls === 'kerb') && p.lap)
if (!lapPrims.some((p) => p.lap === true)) throw new Error('no core road primitives — check the rules')
const trisOfPrims = (list) => {
  const out = []
  for (const p of list) {
    const pos = p.prim.getAttribute('POSITION').getArray()
    const idx = p.prim.getIndices()?.getArray()
    const n = idx ? idx.length : pos.length / 3
    for (let t = 0; t < n; t += 3) { const tri = []; for (let k = 0; k < 3; k++) { const v = idx ? idx[t + k] : t + k; tri.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]) } out.push(tri) }
  }
  return out
}
const coreTris = trisOfPrims(lapPrims.filter((p) => p.lap === true))
const nearTris = trisOfPrims(lapPrims.filter((p) => p.lap === 'near'))
const wallTris = trisOfPrims(prims.filter((p) => p.cls === 'wall'))
const roadTris = [...coreTris, ...nearTris] // [[x,y,z]×3] in final metres; heights are sampled from these
let rlo = [Infinity, Infinity], rhi = [-Infinity, -Infinity]
for (const tri of roadTris) for (const [x, , z] of tri) { rlo = [Math.min(rlo[0], x), Math.min(rlo[1], z)]; rhi = [Math.max(rhi[0], x), Math.max(rhi[1], z)] }
const extent = Math.max(rhi[0] - rlo[0], rhi[1] - rlo[1])
const RES = cfg.res ?? (extent > 1400 ? 2 : 1)
const PAD = 4
const gx0 = Math.floor(rlo[0] / RES) * RES - PAD * RES, gz0 = Math.floor(rlo[1] / RES) * RES - PAD * RES
const GW = Math.ceil((rhi[0] - gx0) / RES) + PAD + 1, GH = Math.ceil((rhi[1] - gz0) / RES) + PAD + 1
const cellX = (x) => Math.round((x - gx0) / RES), cellZ = (z) => Math.round((z - gz0) / RES)
const at = (g, x, z) => (x < 0 || z < 0 || x >= GW || z >= GH ? 0 : g[z * GW + x])
const rasterise = (tris) => {
  const g = new Uint8Array(GW * GH)
  for (const tri of tris) {
    const c = tri.map(([x, , z]) => [(x - gx0) / RES, (z - gz0) / RES])
    const zmin = Math.max(0, Math.ceil(Math.min(c[0][1], c[1][1], c[2][1]))), zmax = Math.min(GH - 1, Math.floor(Math.max(c[0][1], c[1][1], c[2][1])))
    for (let cz = zmin; cz <= zmax; cz++) {
      const xs = []
      for (let e = 0; e < 3; e++) {
        const a = c[e], b = c[(e + 1) % 3]
        if ((cz >= a[1] && cz < b[1]) || (cz >= b[1] && cz < a[1])) xs.push(a[0] + ((cz - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
      if (xs.length < 2) continue
      xs.sort((u, v) => u - v)
      for (let cx = Math.max(0, Math.ceil(xs[0])); cx <= Math.min(GW - 1, Math.floor(xs[1])); cx++) g[cz * GW + cx] = 1
    }
  }
  return g
}
// Walls are vertical, so their footprint is their edges: 4-connected lines, which
// the 8-connected skeleton cannot slip through diagonally. Only walls at road level
// cut; a bridge parapet or gantry crossing above the road must not sever the lap.
const heightGrid = new Float32Array(GW * GH).fill(NaN)
for (const tri of coreTris) for (const [x, y, z] of tri) heightGrid[cellZ(z) * GW + cellX(x)] = y
const roadHeightNear = (x, z) => { for (let r = 0; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < GW && Z < GH && Number.isFinite(heightGrid[Z * GW + X])) return heightGrid[Z * GW + X] } return NaN }
// Highest surface per cell (plane-interpolated), NaN where nothing covers the cell centre.
const rasteriseTop = (tris, lowest = false) => {
  const g = new Float32Array(GW * GH).fill(NaN)
  for (const tri of tris) {
    const [p0, p1, p2] = tri
    const ux = p1[0] - p0[0], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vz = p2[2] - p0[2]
    const det = ux * vz - uz * vx
    if (Math.abs(det) < 1e-6) continue
    const c = tri.map(([x, , z]) => [(x - gx0) / RES, (z - gz0) / RES])
    const zmin = Math.max(0, Math.ceil(Math.min(c[0][1], c[1][1], c[2][1]))), zmax = Math.min(GH - 1, Math.floor(Math.max(c[0][1], c[1][1], c[2][1])))
    for (let cz = zmin; cz <= zmax; cz++) {
      const xs = []
      for (let e = 0; e < 3; e++) {
        const a = c[e], b = c[(e + 1) % 3]
        if ((cz >= a[1] && cz < b[1]) || (cz >= b[1] && cz < a[1])) xs.push(a[0] + ((cz - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
      if (xs.length < 2) continue
      xs.sort((u, v) => u - v)
      for (let cx = Math.max(0, Math.ceil(xs[0])); cx <= Math.min(GW - 1, Math.floor(xs[1])); cx++) {
        const wx = gx0 + cx * RES - p0[0], wz = gz0 + cz * RES - p0[2]
        const bu = (wx * vz - wz * vx) / det, bv = (ux * wz - uz * wx) / det
        const y = p0[1] + bu * (p1[1] - p0[1]) + bv * (p2[1] - p0[1])
        const i = cz * GW + cx
        if (lowest ? !(g[i] <= y) : !(g[i] >= y)) g[i] = y
      }
    }
  }
  return g
}
const rasteriseEdges = (tris, checkHeight = true) => {
  const g = new Uint8Array(GW * GH)
  const mark = (x, z) => { if (x >= 0 && z >= 0 && x < GW && z < GH) g[z * GW + x] = 1 }
  for (const tri of tris) for (let e = 0; e < 3; e++) {
    const a = tri[e], b = tri[(e + 1) % 3]
    const low = Math.min(a[1], b[1])
    if (checkHeight) { const hr = roadHeightNear(cellX((a[0] + b[0]) / 2), cellZ((a[2] + b[2]) / 2)); if (!Number.isFinite(hr) || low > hr + 2.5 || low < hr - 4) continue }
    let x0 = cellX(a[0]), z0 = cellZ(a[2]); const x1 = cellX(b[0]), z1 = cellZ(b[2])
    if (!Number.isFinite(x0 + z0 + x1 + z1)) continue
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0), sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1
    if (dx + dz > 4000) continue // a broken edge spanning the map is not a wall
    let err = dx - dz
    for (let guard = 0; guard <= dx + dz + 2; guard++) {
      mark(x0, z0)
      if (x0 === x1 && z0 === z1) break
      const e2 = 2 * err
      if (e2 > -dz) { err -= dz; x0 += sx; mark(x0, z0) }
      if (e2 < dx) { err += dx; z0 += sz }
    }
  }
  return g
}
const morph = (g, fn) => { const o = new Uint8Array(GW * GH); for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) { let cnt = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cnt += at(g, x + dx, z + dz); o[z * GW + x] = fn(cnt, g[z * GW + x]) ? 1 : 0 } return o }
const dilate = (g, r) => { const o = new Uint8Array(GW * GH); for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) { if (!g[z * GW + x]) continue; for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) { const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < GW && Z < GH) o[Z * GW + X] = 1 } } return o }
let grid = rasterise(coreTris)
// Thin seed strips (edge lines under a metre wide) rarely cover a cell centre, so
// their edges are marked too — a seed line must never break.
if (cfg.coreRadius) { const e = rasteriseEdges(coreTris, false); for (let i = 0; i < grid.length; i++) if (e[i]) grid[i] = 1 }
// `coreRadius`: when the track shares its asphalt material with paddocks and car
// parks, the core rules only seed the lap (edge lines, kerbs) and the general
// asphalt within this many metres of a seed joins the core; the rest stays out.
if (cfg.coreRadius && nearTris.length) { const near = rasterise(nearTris), mask = dilate(grid, Math.max(1, Math.round(cfg.coreRadius / RES))); if (process.env.DEBUG_BAND) { const cells = (g, step) => { const o = []; for (let i = 0; i < g.length; i += step) if (g[i]) o.push([gx0 + (i % GW) * RES, gz0 + Math.floor(i / GW) * RES]); return o }; fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-core.json`), JSON.stringify({ band: cells(grid, 1), infield: cells(near, 3), res: RES })) } for (let i = 0; i < grid.length; i++) if (near[i] && mask[i]) grid[i] = 1 }
grid = morph(grid, (cnt) => cnt > 0)
grid = morph(grid, (cnt) => cnt === 9)
// `coreClose`: a wider morphological close on the core, for cores built from sparse
// seeds (thin edge-line strips leave slits in the band that the seed discs miss).
if (cfg.coreClose) { const r = Math.max(1, Math.round(cfg.coreClose / RES)); const inv = (g) => { const o = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) o[i] = g[i] ? 0 : 1; return o }; grid = inv(dilate(inv(dilate(grid, r)), r)) }
let fullGrid = rasterise(roadTris)
fullGrid = morph(fullGrid, (cnt) => cnt > 0)
fullGrid = morph(fullGrid, (cnt) => cnt === 9)
let roadTopGrid = null // highest road surface per cell, for the edge walks
// Verges laid over the asphalt polygon: where a grass strip or gravel sits on top of
// road triangles (Sepang's T1 apex has a grass verge and a painted logo over the
// asphalt), the car drives on the verge, so those cells leave the road raster.
{
  const coverTris = trisOfPrims(prims.filter((p) => p.cls === 'terrain' || p.cls === 'gravel'))
  if (coverTris.length) {
    const roadTop = rasteriseTop(roadTris), roadBottom = rasteriseTop(roadTris, true), coverTop = rasteriseTop(coverTris)
    roadTopGrid = roadTop
    let removed = 0
    if (process.env.DEBUG_WALK) {
      // cover minus road top in decimetres around the point: digits = cover above (capped 9), letters = cover below, '#' road without cover, '.' nothing
      const [qx, qz] = process.env.DEBUG_WALK.split(',').map(Number)
      const cx0 = cellX(qx), cz0 = cellZ(qz), R2 = Math.round(30 / RES)
      for (let cz = cz0 - R2; cz <= cz0 + R2; cz++) { let row = ''; for (let cx = cx0 - R2; cx <= cx0 + R2; cx++) { const i = cz * GW + cx; let ch = '.'; if (cx >= 0 && cz >= 0 && cx < GW && cz < GH && (grid[i] || fullGrid[i])) { ch = '#'; if (Number.isFinite(coverTop[i]) && Number.isFinite(roadTop[i])) { const d = Math.round((coverTop[i] - roadTop[i]) * 10); ch = d >= 0 ? String(Math.min(9, d)) : String.fromCharCode(96 + Math.min(26, -d)) } } row += ch } console.log('COVER ' + row) }
    }
    // Only a verge within 60 cm above the lowest road surface counts: an embankment beside a
    // bridge, a roof or a hillside classed as terrain must not cut the road under it.
    for (let i = 0; i < grid.length; i++) if ((grid[i] || fullGrid[i]) && coverTop[i] >= roadBottom[i] - 0.15 && coverTop[i] <= roadBottom[i] + 0.6) { if (grid[i]) removed++; grid[i] = 0; fullGrid[i] = 0 }
    console.log(`${removed} core cells under verges or gravel that sit on the asphalt — removed from the road`)
  }
}
const wallGrid = wallTris.length ? rasteriseEdges(wallTris) : null
// Kerbs are lap surface for tracing, but the usable width the AI gets stops at
// them: a 3D sausage kerb taken at speed launches a car.
const kerbTris = trisOfPrims(prims.filter((p) => p.cls === 'kerb'))
const kerbGrid = kerbTris.length ? rasteriseEdges(kerbTris) : null
let roadCells = 0; for (const v of grid) roadCells += v
console.log(`lap surface raster ${GW}×${GH} @ ${RES} m, ${Math.round(roadCells * RES * RES)} m²`)
const thin = (g) => {
  const img = Uint8Array.from(g)
  let changed = true
  while (changed) {
    changed = false
    for (const pass of [0, 1]) {
      const del = []
      for (let z = 1; z < GH - 1; z++) for (let x = 1; x < GW - 1; x++) {
        if (!img[z * GW + x]) continue
        const p2 = at(img, x, z - 1), p3 = at(img, x + 1, z - 1), p4 = at(img, x + 1, z), p5 = at(img, x + 1, z + 1), p6 = at(img, x, z + 1), p7 = at(img, x - 1, z + 1), p8 = at(img, x - 1, z), p9 = at(img, x - 1, z - 1)
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
        if (B < 2 || B > 6) continue
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
        let A = 0; for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++
        if (A !== 1) continue
        if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
        del.push(z * GW + x)
      }
      for (const i of del) img[i] = 0
      if (del.length) changed = true
    }
  }
  return img
}
// The lap is the ring of road that separates the infield from the outside world.
// Non-road cells reachable from the raster border are the outside; the largest
// enclosed non-road region is the infield; road cells equidistant from both form
// a band around the lap. Paddocks, car parks and access roads hang off the
// outside and never separate it from the infield, so they drop out here without
// any cycle search (which explodes on the internal loops of a paddock).
const N_CELLS = GW * GH
const fillFrom = (g, label, seeds, id, q) => { let h = 0, t = 0; for (const c of seeds) { if (label[c] !== -1 || g[c]) continue; label[c] = id; q[t++] = c }; let count = 0; while (h < t) { const c = q[h++]; count++; const x = c % GW, z = (c - x) / GW; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const n = Z * GW + X; if (label[n] === -1 && !g[n]) { label[n] = id; q[t++] = n } } } return count }
const borderCells = (g) => { const b = []; for (let x = 0; x < GW; x++) { if (!g[x]) b.push(x); if (!g[(GH - 1) * GW + x]) b.push((GH - 1) * GW + x) } for (let z = 0; z < GH; z++) { if (!g[z * GW]) b.push(z * GW); if (!g[z * GW + GW - 1]) b.push(z * GW + GW - 1) } return b }
// Regions of a grid: label 1 = outside, 2.. = enclosed; returns the largest enclosed id/count.
const labelRegions = (g) => { const label = new Int32Array(N_CELLS).fill(-1); const q = new Int32Array(N_CELLS); fillFrom(g, label, borderCells(g), 1, q); let best = -1, bestCount = 0, next = 2; for (let i = 0; i < N_CELLS; i++) { if (g[i] || label[i] !== -1) continue; const count = fillFrom(g, label, [i], next, q); if (count > bestCount) { bestCount = count; best = next } next++ } return { label, best, bestCount, regions: next - 2 } }
// Widen the core until a real infield appears; the widened-only cells that separate
// it from the outside plug the ring gap. Returns { K, plug } or null.
const findPlug = (g, roadCells) => {
  const q = new Int32Array(N_CELLS)
  for (const K of [2, 4, 6, 9, 13, 18]) {
    const gK = dilate(g, Math.max(1, Math.round(K / RES)))
    const { label, best, bestCount } = labelRegions(gK)
    if (best < 0 || (bestCount < 2 * roadCells && bestCount < 0.02 * N_CELLS)) continue
    const near = (id, cap) => { const d = new Int32Array(N_CELLS).fill(-1); let h = 0, t = 0; for (let i = 0; i < N_CELLS; i++) if (label[i] === id) { d[i] = 0; q[t++] = i } while (h < t) { const c = q[h++]; if (d[c] >= cap) continue; const x = c % GW, z = (c - x) / GW; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const n = Z * GW + X; if (d[n] < 0) { d[n] = d[c] + 1; q[t++] = n } } } return d }
    const cap = Math.round(K / RES) + 3
    const dInf = near(best, cap), dOut = near(1, cap)
    const plug = []
    let sx = 0, sz = 0
    for (let i = 0; i < N_CELLS; i++) if (gK[i] && !g[i] && dInf[i] >= 0 && dOut[i] >= 0) { plug.push(i); sx += i % GW; sz += Math.floor(i / GW) }
    console.log(`ring gap: widening the core by ${K} m encloses an infield of ${Math.round(bestCount * RES * RES)} m²; the plug (${plug.length} cells) centres on (${(gx0 + (sx / Math.max(1, plug.length)) * RES).toFixed(0)}, ${(gz0 + (sz / Math.max(1, plug.length)) * RES).toFixed(0)})`)
    return { K, plug }
  }
  return null
}
const lapBandOn = (g, allowPlug) => {
  const { label, best, bestCount, regions } = labelRegions(g)
  // A circuit's infield is several times its road area; a smaller "infield" is a pocket
  // and the real ring is open somewhere.
  let roadCells = 0; for (let i = 0; i < N_CELLS; i++) roadCells += g[i]
  const tooSmall = best < 0 || (bestCount < 2 * roadCells && bestCount < 0.02 * N_CELLS) || (allowPlug && !!process.env.FORCE_PLUG)
  if (tooSmall && allowPlug) {
    const found = findPlug(g, roadCells)
    if (found && found.plug.length) {
      // Bridging a gap in the model's road ring (a bridge deck in another material, a
      // missing patch) is automatic and bounded; the plug is logged above.
      const patched = Uint8Array.from(g)
      for (const i of found.plug) patched[i] = 1
      console.log(`bridging the ~${found.K * 2} m ring gap with ${found.plug.length} road cells and tracing again`)
      return lapBandOn(patched, false)
    }
  }
  if (process.env.DEBUG_BAND && tooSmall) { const pts = []; for (let i = 0; i < N_CELLS; i++) if (g[i]) pts.push([gx0 + (i % GW) * RES, gz0 + Math.floor(i / GW) * RES]); fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-band.json`), JSON.stringify({ band: pts, infield: [], res: RES })) }
  if (tooSmall) { console.log(`no infield: ${regions} enclosed regions, largest ${Math.round(bestCount * RES * RES)} m² — the core raster does not close around one (the outside leaks in through a gap); falling back to the skeleton`); return null }
  const q = new Int32Array(N_CELLS)
  const dist = (ids) => { const d = new Int32Array(N_CELLS).fill(-1); let h = 0, t = 0; for (let i = 0; i < N_CELLS; i++) { if (!g[i]) continue; const x = i % GW, z = (i - x) / GW; let touch = false; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < GW && Z < GH && ids.has(label[Z * GW + X])) touch = true } if (touch) { d[i] = 0; q[t++] = i } } while (h < t) { const c = q[h++]; const x = c % GW, z = (c - x) / GW; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const n = Z * GW + X; if (g[n] && d[n] < 0) { d[n] = d[c] + 1; q[t++] = n } } } return d }
  // Every other enclosed pocket (a strip between groove and kerb, a run-off ringed
  // by kerbs) joins whichever side its neighbouring road cells are nearer to;
  // left alone it would block the distance field and cut the band.
  const inside = new Set([best]), outside = new Set([1])
  const d1In = dist(inside), d1Out = dist(outside)
  const votes = new Map()
  for (let i = 0; i < N_CELLS; i++) { if (!g[i]) continue; const x = i % GW, z = (i - x) / GW; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const r = label[Z * GW + X]; if (r < 2 || r === best) continue; const v = votes.get(r) ?? [0, 0]; if (d1In[i] >= 0 && (d1Out[i] < 0 || d1In[i] < d1Out[i])) v[0]++; else if (d1Out[i] >= 0) v[1]++; votes.set(r, v) } }
  for (const [r, [vin, vout]] of votes) (vin >= vout ? inside : outside).add(r)
  const dIn = dist(inside), dOut = dist(outside)
  const band = new Uint8Array(N_CELLS)
  let cells = 0
  for (let i = 0; i < N_CELLS; i++) if (g[i] && dIn[i] >= 0 && dOut[i] >= 0 && Math.abs(dIn[i] - dOut[i]) <= 1) { band[i] = 1; cells++ }
  console.log(`infield ${Math.round(bestCount * RES * RES)} m² (${regions} enclosed regions); lap band ${cells} cells`)
  if (process.env.DEBUG_BAND) { const pts = []; for (let i = 0; i < N_CELLS; i++) if (band[i]) pts.push([gx0 + (i % GW) * RES, gz0 + Math.floor(i / GW) * RES]); const inf = []; for (let i = 0; i < N_CELLS; i += 3) if (label[i] === best) inf.push([gx0 + (i % GW) * RES, gz0 + Math.floor(i / GW) * RES]); fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-band.json`), JSON.stringify({ band: pts, infield: inf, res: RES })) }
  if (!cells) return null
  // The plug is road for the trace only; the bridged cells also join the grid so the
  // re-centring walk and width measurement see a continuous surface there.
  if (g !== grid) for (let i = 0; i < N_CELLS; i++) if (g[i]) grid[i] = 1
  return morph(band, (cnt) => cnt > 0)
}
// `tracer: 'skeleton'` keeps the whole-raster skeleton + largest cycle for layouts
// where the band is not the lap (Drift Park is a wide pad with an island).
if (process.env.DEBUG_RASTER) {
  // Connected components of the core raster: a lap that will not close is usually two pieces.
  const lab = new Int32Array(GW * GH).fill(-1); const comps = []
  for (let i = 0; i < GW * GH; i++) { if (!grid[i] || lab[i] >= 0) continue; const id = comps.length; const st = [i]; lab[i] = id; let n = 0, x0 = GW, x1 = 0, z0 = GH, z1 = 0; while (st.length) { const c = st.pop(); n++; const x = c % GW, z = (c - x) / GW; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const j = Z * GW + X; if (grid[j] && lab[j] < 0) { lab[j] = id; st.push(j) } } } comps.push({ n, x0, x1, z0, z1 }) }
  comps.sort((a, b) => b.n - a.n)
  console.log('core components: ' + comps.slice(0, 6).map((c) => `${c.n} cells x[${(gx0 + c.x0 * RES).toFixed(0)}..${(gx0 + c.x1 * RES).toFixed(0)}] z[${(gz0 + c.z0 * RES).toFixed(0)}..${(gz0 + c.z1 * RES).toFixed(0)}]`).join(' | '))
}
if (process.env.DEBUG_RASTER) { const cells = []; for (let i = 0; i < grid.length; i++) if (grid[i]) cells.push([gx0 + (i % GW) * RES, gz0 + Math.floor(i / GW) * RES]); fs.writeFileSync(process.env.DEBUG_RASTER, JSON.stringify({ line: [], skeleton: cells, road: roadTris.map((t) => t.map((v) => [+v[0].toFixed(1), +v[2].toFixed(1)])) })); console.log(`core raster ${cells.length} cells → ${process.env.DEBUG_RASTER}`) }
const band = cfg.tracer === 'skeleton' ? null : lapBandOn(grid, true)
let skel = thin(band ?? grid)
const nb8 = (g, x, z) => { const out = []; for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) if (at(g, x + dx, z + dz)) out.push([x + dx, z + dz]); return out }
let pruned = 0
for (let round = 0; round < 80; round++) {
  let removed = 0
  const ends = []
  for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x] && nb8(skel, x, z).length === 1) ends.push([x, z])
  for (const end of ends) {
    if (!skel[end[1] * GW + end[0]]) continue
    const chain = [end]; let prev = null, cur = end
    for (;;) { const n = nb8(skel, cur[0], cur[1]).filter((q) => !prev || q[0] !== prev[0] || q[1] !== prev[1]); if (n.length !== 1) break; prev = cur; cur = n[0]; chain.push(cur) }
    for (const [x, z] of chain.slice(0, -1)) skel[z * GW + x] = 0
    pruned += chain.length - 1
    removed++
  }
  if (!removed) break
  skel = thin(skel)
}
let skelCells = 0; for (const v of skel) skelCells += v
if (!skelCells) throw new Error('the lap surface skeleton pruned away entirely — no closed loop in the road mesh')
const isJ = (x, z) => skel[z * GW + x] && nb8(skel, x, z).length >= 3
const jid = new Int32Array(GW * GH).fill(-1)
const junctions = []
for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) {
  if (!isJ(x, z) || jid[z * GW + x] >= 0) continue
  const id = junctions.length, pixels = [], stack = [[x, z]]
  jid[z * GW + x] = id
  while (stack.length) { const [px, pz] = stack.pop(); pixels.push([px, pz]); for (const [nx, nz] of nb8(skel, px, pz)) if (isJ(nx, nz) && jid[nz * GW + nx] < 0) { jid[nz * GW + nx] = id; stack.push([nx, nz]) } }
  junctions.push({ pixels })
}
let cyclePaths
if (!junctions.length) {
  let start = null
  for (let z = 0; z < GH && !start; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) { start = [x, z]; break }
  const path = [start]; let prev = null, cur = start
  for (;;) { const n = nb8(skel, cur[0], cur[1]).filter((q) => !prev || q[0] !== prev[0] || q[1] !== prev[1]); if (!n.length || (n[0][0] === start[0] && n[0][1] === start[1])) break; prev = cur; cur = n[0]; path.push(cur) }
  cyclePaths = [path]
  console.log(`skeleton ${skelCells} cells, single loop of ${path.length} cells`)
} else {
  const edgesG = []
  const visitedEdge = new Set()
  for (let j = 0; j < junctions.length; j++) {
    for (const [px, pz] of junctions[j].pixels) for (const first of nb8(skel, px, pz)) {
      if (jid[first[1] * GW + first[0]] >= 0) continue
      const path = [[px, pz], first]
      let prev = [px, pz], cur = first, endJ = -1
      for (let guard = 0; guard < 200000; guard++) {
        const j2 = jid[cur[1] * GW + cur[0]]
        if (j2 >= 0) { endJ = j2; break }
        const n = nb8(skel, cur[0], cur[1]).filter((q) => q[0] !== prev[0] || q[1] !== prev[1])
        if (!n.length) break
        prev = cur; cur = n[0]; path.push(cur)
      }
      if (endJ < 0) continue
      const key = [j, endJ, first[0], first[1]].join(','), rkey = [endJ, j, path[path.length - 2][0], path[path.length - 2][1]].join(',')
      if (visitedEdge.has(key) || visitedEdge.has(rkey)) continue
      visitedEdge.add(key)
      edgesG.push({ a: j, b: endJ, path })
    }
  }
  // Parallel roads between the same two junctions — a run-off apron beyond a grass hump
  // (Sepang's T1), a pit lane, a service road — keep only the widest: the racing surface
  // is the wide one, and the largest-area rule would otherwise take whichever runs on the
  // outside. Two lobes of a figure-eight also share their junction but lie far apart, so
  // only edges within 25 m of each other count as parallel.
  {
    const dt = new Float32Array(GW * GH).fill(Infinity)
    const q = []
    for (let i = 0; i < GW * GH; i++) if (!fullGrid[i]) { dt[i] = 0; q.push(i) }
    let head = 0
    const cap = 15 / RES
    while (head < q.length) { const i = q[head++]; const d = dt[i]; if (d >= cap) continue; const x = i % GW, z = (i - x) / GW; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= GW || Z >= GH) continue; const j = Z * GW + X; if (dt[j] > d + 1) { dt[j] = d + 1; q.push(j) } } }
    const width = (ed) => { let sum = 0; for (const [x, z] of ed.path) sum += dt[z * GW + x]; return (sum / ed.path.length) * RES }
    const near = (p, qth) => { let sum = 0, n = 0; for (let k = 0; k < p.path.length; k += 5) { let best = Infinity; for (let m = 0; m < qth.path.length; m += 5) best = Math.min(best, dist2(p.path[k], qth.path[m])); sum += Math.min(best, 200); n++ } return (sum / n) * RES }
    const groups = new Map()
    edgesG.forEach((ed, i) => { const key = `${Math.min(ed.a, ed.b)},${Math.max(ed.a, ed.b)}`; (groups.get(key) ?? groups.set(key, []).get(key)).push(i) })
    const dropped = new Set()
    for (const list of groups.values()) {
      if (list.length < 2) continue
      const sorted = list.map((i) => ({ i, w: width(edgesG[i]) })).sort((u, v) => v.w - u.w)
      for (let k = 1; k < sorted.length; k++) if (near(edgesG[sorted[k].i], edgesG[sorted[0].i]) < 25) { dropped.add(sorted[k].i); console.log(`parallel road ${sorted[k].w.toFixed(1)} m wide beside one ${sorted[0].w.toFixed(1)} m wide — dropped`) }
    }
    if (dropped.size) { const kept = edgesG.filter((_, i) => !dropped.has(i)); edgesG.length = 0; edgesG.push(...kept) }
  }
  // Figure-eight crossings: a bridge over the lap reads as one 4-way junction (or two
  // close 3-way ones) and no simple cycle can pass it twice, so the largest cycle would be
  // a single lobe. Pair each arm with the arm opposite it and split the junction so the
  // loop goes straight through — a topology hint from the config, not a hand-authored line.
  const crossingNodes = new Set()
  for (const [wx, wz] of cfg.crossings ?? []) {
    const near = new Set()
    junctions.forEach((jn, i) => { const c = jn.pixels.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / jn.pixels.length); if (Math.hypot(gx0 + c[0] * RES - wx, gz0 + c[1] * RES - wz) < 25) near.add(i) })
    if (!near.size) { console.log(`crossing ${wx},${wz}: no junction within 25 m — ignored`); continue }
    const J = [...near][0]
    for (let i = edgesG.length - 1; i >= 0; i--) { const ed = edgesG[i]; if (near.has(ed.a) && near.has(ed.b)) { edgesG.splice(i, 1); continue } if (near.has(ed.a)) ed.a = J; if (near.has(ed.b)) ed.b = J }
    const ends = []
    edgesG.forEach((ed, i) => { if (ed.a === J) ends.push({ i, end: 'a' }); if (ed.b === J) ends.push({ i, end: 'b' }) })
    if (ends.length !== 4) { console.log(`crossing ${wx},${wz}: ${ends.length} arms at the junction — not split`); continue }
    const dir = ({ i, end }) => { const p = end === 'a' ? edgesG[i].path : [...edgesG[i].path].reverse(); const k = Math.min(p.length - 1, Math.round(8 / RES)); const dx = p[k][0] - p[0][0], dz = p[k][1] - p[0][1], n = Math.hypot(dx, dz) || 1; return [dx / n, dz / n] }
    const d = ends.map(dir)
    const dot = (u, v) => d[u][0] * d[v][0] + d[u][1] * d[v][1]
    const pairings = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]]
    const pr = pairings.sort((p, q) => (dot(...p[0]) + dot(...p[1])) - (dot(...q[0]) + dot(...q[1])))[0]
    const J2 = junctions.length
    junctions.push({ pixels: junctions[J].pixels })
    for (const k of pr[1]) { const { i, end } = ends[k]; edgesG[i][end] = J2 }
    crossingNodes.add(J); crossingNodes.add(J2)
    console.log(`crossing ${wx},${wz}: junction split into two straight-through passes`)
  }
  const cycles = []
  const dfs = (startNode, node, usedEdges, visitedNodes, order) => {
    for (let e = 0; e < edgesG.length; e++) {
      if (usedEdges.has(e)) continue
      const ed = edgesG[e]
      if (ed.a !== node && ed.b !== node) continue
      const next = ed.a === node ? ed.b : ed.a
      if (next === startNode) { cycles.push([...order, e]); continue }
      if (visitedNodes.has(next) || e < order[0]) continue
      usedEdges.add(e); visitedNodes.add(next)
      dfs(startNode, next, usedEdges, visitedNodes, [...order, e])
      usedEdges.delete(e); visitedNodes.delete(next)
    }
  }
  for (let e0 = 0; e0 < edgesG.length && cycles.length < 20000; e0++) {
    const ed = edgesG[e0]
    if (ed.a === ed.b) { cycles.push([e0]); continue }
    dfs(ed.a, ed.b, new Set([e0]), new Set([ed.a, ed.b]), [e0])
  }
  const area = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }
  const toPoly = (cycle) => {
    const first = edgesG[cycle[0]]
    let node = first.a
    if (cycle.length > 1) { const second = edgesG[cycle[1]]; node = second.a === first.b || second.b === first.b ? first.a : first.b }
    const poly = [], cuts = []
    for (const e of cycle) { const ed = edgesG[e]; if (crossingNodes.has(node)) cuts.push(poly.length); const p = ed.a === node ? ed.path : [...ed.path].reverse(); poly.push(...p.slice(0, -1)); node = ed.a === node ? ed.b : ed.a }
    poly.cuts = cuts
    return poly
  }
  // A figure-eight's lobes wind opposite ways and cancel in one shoelace sum: split the
  // polygon where it passes the crossing and add the lobes' absolute areas instead.
  const lobeArea = (poly) => { const c = poly.cuts ?? []; if (c.length !== 2) return area(poly); return area(poly.slice(c[0], c[1])) + area([...poly.slice(c[1]), ...poly.slice(0, c[0])]) }
  const dd = new Map()
  for (const c of cycles) dd.set([...c].sort((u, v) => u - v).join(','), c)
  // A figure-eight's lobes wind in opposite directions and cancel in the shoelace sum,
  // so with crossings configured the lap is the longest simple cycle instead.
  const plen = (poly) => { let l = 0; for (let i = 0; i < poly.length; i++) l += dist2(poly[i], poly[(i + 1) % poly.length]); return l }
  const ranked = [...dd.values()].map((c) => toPoly(c)).map((poly) => ({ poly, area: lobeArea(poly), len: plen(poly) })).sort((u, v) => v.area - u.area)
  if (!ranked.length) throw new Error('the lap surface skeleton has no cycle — the road does not close')
  console.log(`skeleton ${skelCells} cells (${pruned} dead-end cells pruned), ${junctions.length} junctions, ${edgesG.length} edges, ${ranked.length} cycles; largest ${Math.round(ranked[0].area * RES * RES)} m², ${Math.round(ranked[0].len * RES)} m long`)
  cyclePaths = ranked.map((r) => r.poly)
}
let mid = cyclePaths[0].map(([x, z]) => [gx0 + x * RES, gz0 + z * RES])
for (let guard = 0; guard < 20; guard++) {
  let best = null
  const n = mid.length
  for (let i = 0; i < n; i++) for (let j = i + 12; j < n && j - i < n - 12; j++) if (dist2(mid[i], mid[j]) < 3 && (!best || j - i > best.j - best.i)) best = { i, j }
  if (!best) break
  mid = [...mid.slice(0, best.i + 1), ...mid.slice(best.j)]
}
const smooth = (arr, k) => arr.map((_, i) => { let x = 0, z = 0; for (let d = -k; d <= k; d++) { const q = arr[(i + d + arr.length) % arr.length]; x += q[0]; z += q[1] } return [x / (2 * k + 1), z / (2 * k + 1)] })
const sm = Math.max(3, Math.round(6 / RES))
mid = smooth(smooth(smooth(mid, sm), sm), sm)
function resample(arr, step) {
  const out = [], total = arr.reduce((s, p, i) => s + dist2(p, arr[(i + 1) % arr.length]), 0)
  let acc = 0, target = 0
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i], b = arr[(i + 1) % arr.length], seg = dist2(a, b)
    while (target <= acc + seg && target < total) { const u = seg > 0 ? (target - acc) / seg : 0; out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); target += step }
    acc += seg
  }
  return { points: out, length: total }
}
let { points: line, length } = resample(mid, 2)
// Re-centre across the full road: walk both ways along the normal until the
// asphalt ends or a wall cell is met (max 9 m) and move to the midpoint. The raw
// midpoints jitter with the raster's jagged edges and jump at aprons and side
// roads, so the shift is median-filtered over 30 m and smoothed before it is
// applied — a wobble of a metre reads as a corner to the AI's speed profile.
const normalAt = (pts, i) => { const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L] }
// The full asphalt may only extend the core (groove) edge by a road margin — a
// side road or apron joining at a junction must not pull the line sideways.
// An edge walk also stops where the asphalt steps down by 8 cm or more within half a
// metre: a lower run-off sheet beside the road (Sepang's T1 apron, 20 cm under the
// track past a grass hump) is not road for centring or width. Banking drops a couple
// of centimetres per half metre and passes.
const walkGrid = (g, p, nx, nz, sign, max, stopKerbs = false) => { let d = 0, prevTop = NaN; for (let t = 0.5; t <= max; t += 0.5) { const cx = cellX(p[0] + nx * sign * t), cz = cellZ(p[1] + nz * sign * t); if (!at(g, cx, cz) || (wallGrid && at(wallGrid, cx, cz)) || (stopKerbs && kerbGrid && at(kerbGrid, cx, cz))) break; if (roadTopGrid && cx >= 0 && cz >= 0 && cx < GW && cz < GH) { const top = roadTopGrid[cz * GW + cx]; if (Number.isFinite(top)) { if (Number.isFinite(prevTop) && prevTop - top > 0.08) break; prevTop = top } } d = t } return d }
// Walks reach 14 m: a hairpin with run-off asphalt on the outside (Sepang's T1) is 20 m
// wide, and a walk capped short of the far edge cannot centre the line at all.
const walkFrom = (p, nx, nz, sign, stopKerbs = false) => { const core = walkGrid(grid, p, nx, nz, sign, 14); return walkGrid(fullGrid, p, nx, nz, sign, Math.min(14, core + 6), stopKerbs) }
const medianFilter = (arr, k) => arr.map((_, i) => { const w = []; for (let d = -k; d <= k; d++) w.push(arr[(i + d + arr.length) % arr.length]); w.sort((a, b) => a - b); return w[k] })
const meanFilter = (arr, k) => arr.map((_, i) => { let s = 0; for (let d = -k; d <= k; d++) s += arr[(i + d + arr.length) % arr.length]; return s / (2 * k + 1) })
let halfWidths = null
const walkDebug = []
if (nearTris.length || wallGrid) {
  const n = line.length
  const left = new Array(n), right = new Array(n)
  // Kerbs mark the road's edges on a real circuit: centre between them, not across the
  // aprons and second surface layers beyond them (Sepang's T1 has a lower asphalt sheet
  // reaching 12 m inside the kerb, which pulled the line onto the grass verge).
  for (let i = 0; i < n; i++) { const [nx, nz] = normalAt(line, i); left[i] = walkFrom(line[i], nx, nz, -1, true); right[i] = walkFrom(line[i], nx, nz, 1, true) }
  const shift = meanFilter(medianFilter(left.map((l, i) => Math.max(-6, Math.min(6, (right[i] - l) / 2))), 12), 4)
  if (process.env.DEBUG_WALK) {
    // ASCII raster around the point: # core, + road beyond the core, K kerb, W wall, * skeleton, . nothing
    const [qx, qz] = process.env.DEBUG_WALK.split(',').map(Number)
    const cx0 = cellX(qx), cz0 = cellZ(qz), R2 = Math.round(30 / RES)
    const onLine = new Set(line.map((p) => `${cellX(p[0])},${cellZ(p[1])}`))
    for (let cz = cz0 - R2; cz <= cz0 + R2; cz++) { let row = ''; for (let cx = cx0 - R2; cx <= cx0 + R2; cx++) { let ch = at(grid, cx, cz) ? '#' : at(fullGrid, cx, cz) ? '+' : '.'; if (kerbGrid && at(kerbGrid, cx, cz)) ch = 'K'; if (wallGrid && at(wallGrid, cx, cz)) ch = 'W'; if (onLine.has(`${cx},${cz}`)) ch = 'o'; row += ch } console.log(row) }
  }
  if (process.env.DEBUG_WALK) { const [qx, qz] = process.env.DEBUG_WALK.split(',').map(Number); let bi = 0, bd = Infinity; line.forEach((p, k) => { const d = Math.hypot(p[0] - qx, p[1] - qz); if (d < bd) { bd = d; bi = k } }); const o = []; for (let k = bi - 8; k <= bi + 8; k++) { const i = (k + n) % n; o.push(`${i}:L${left[i]}/R${right[i]}/s${shift[i].toFixed(1)}`) } console.log('DEBUG_SHIFT', o.join(' ')) }
  line = line.map((p, i) => { const [nx, nz] = normalAt(line, i); return [p[0] + nx * shift[i], p[1] + nz * shift[i]] })
  line = smooth(line, 2)
  ;({ points: line, length } = resample(line, 2))
  // Usable half-width at each point: the nearer edge, median-filtered.
  const hw = new Array(line.length)
  for (let i = 0; i < line.length; i++) { const [nx, nz] = normalAt(line, i); const l = walkFrom(line[i], nx, nz, -1, true), r = walkFrom(line[i], nx, nz, 1, true); hw[i] = Math.min(l, r); walkDebug.push([l, r]) }
  // The raster only marks cells whose centre is on the asphalt, so each edge reads ~0.4 cells short.
  halfWidths = meanFilter(medianFilter(hw, 12), 4).map((v) => Math.max(3, Math.min(9, v + 0.4 * RES)))
  if (process.env.DEBUG_WALK) {
    const [qx, qz] = process.env.DEBUG_WALK.split(',').map(Number)
    let i = 0, bd = Infinity
    line.forEach((p, k) => { const d = Math.hypot(p[0] - qx, p[1] - qz); if (d < bd) { bd = d; i = k } })
    const [nx, nz] = normalAt(line, i)
    for (const sign of [-1, 1]) { const cells = []; for (let t = 0; t <= 10; t += 0.5) { const cx = cellX(line[i][0] + nx * sign * t), cz = cellZ(line[i][1] + nz * sign * t); cells.push(`${t}:${at(grid, cx, cz)}${at(fullGrid, cx, cz)}${wallGrid ? at(wallGrid, cx, cz) : '-'}`) } console.log(`DEBUG_WALK idx ${i} at (${line[i][0].toFixed(0)}, ${line[i][1].toFixed(0)}) sign ${sign} [core|full|wall]: ${cells.join(' ')}`) }
  }
}

// --- direction, start point, elevation ---------------------------------------------------
const signedArea = line.reduce((a, p, i) => { const q = line[(i + 1) % line.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0) / 2
// Seen from above in three's right-handed frame (+x right, +z down the page),
// a clockwise lap has positive shoelace area in (x, z).
const isCw = signedArea > 0
if ((cfg.direction === 'cw') !== isCw) { line.reverse(); if (halfWidths) halfWidths.reverse() }
// Start: beside the pit lane when the model has one, else mid-longest-straight.
const pitPts = []
for (const p of prims) if (p.cls === 'pit') { const pos = p.prim.getAttribute('POSITION').getArray(); for (let i = 0; i < pos.length; i += 3) pitPts.push([pos[i], pos[i + 1], pos[i + 2]]) }
// A start marker (start lights, gantry, painted line) pins the start line; otherwise
// the pit lane centroid does, and a track without either starts mid-longest-straight.
const markerPts = []
if (cfg.startMarker) for (const p of prims) if (cfg.startMarker.test(p.matName) || cfg.startMarker.test(p.pathStr)) { const pos = p.prim.getAttribute('POSITION').getArray(); for (let i = 0; i < pos.length; i += 3) markerPts.push([pos[i], pos[i + 1], pos[i + 2]]) }
const centroid2 = (pts) => pts.reduce((s, q) => [s[0] + q[0], s[1] + q[2]], [0, 0]).map((v) => v / pts.length)
const nearestTo = (c) => { let bd = Infinity, bi = 0; line.forEach((p, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i } }); return [bi, bd] }
let startIdx = 0
let startNote = ''
if (markerPts.length) {
  const [bi, bd] = nearestTo(centroid2(markerPts))
  startIdx = bi
  startNote = `start at the model's start marker (${bd.toFixed(0)} m from it)`
} else if (pitPts.length) {
  const [bi, bd] = nearestTo(centroid2(pitPts))
  startIdx = bi
  startNote = `start beside the pit lane (${bd.toFixed(0)} m from its centroid)`
} else {
  const heading = (i) => { const a = line[(i - 1 + line.length) % line.length], b = line[(i + 1) % line.length]; return Math.atan2(b[0] - a[0], b[1] - a[1]) }
  const turn = line.map((_, i) => { let d = heading((i + 1) % line.length) - heading(i); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d) })
  let bestStart = 0, bestLen = 0, runStart = -1
  const n = turn.length
  for (let i = 0; i < 2 * n; i++) { const f = turn[i % n] < 0.012; if (f && runStart < 0) runStart = i; if ((!f || i === 2 * n - 1) && runStart >= 0) { const len = i - runStart; if (len > bestLen && len < n) { bestLen = len; bestStart = runStart } runStart = -1 } }
  startIdx = (bestStart + Math.floor(bestLen / 2)) % line.length
  startNote = `start mid-longest-straight (${bestLen * 2} m)`
}
line = [...line.slice(startIdx), ...line.slice(0, startIdx)]
if (halfWidths) halfWidths = [...halfWidths.slice(startIdx), ...halfWidths.slice(0, startIdx)]
// Elevation: barycentric height of the lap-surface triangle under each point
// (nearest road vertex within 12 m as a fallback), then lightly smoothed.
const tgrid = new Map(), TC = 20
for (const tri of roadTris) {
  const xs = tri.map((v) => v[0]), zs = tri.map((v) => v[2])
  for (let cx = Math.floor(Math.min(...xs) / TC); cx <= Math.floor(Math.max(...xs) / TC); cx++) for (let cz = Math.floor(Math.min(...zs) / TC); cz <= Math.floor(Math.max(...zs) / TC); cz++) { const k = `${cx},${cz}`; (tgrid.get(k) ?? tgrid.set(k, []).get(k)).push(tri) }
}
// All road surfaces under a point: the heights of every containing triangle (the
// nearest vertex within 12 m when none contains it).
const heightsAt = ([x, z]) => {
  const k = `${Math.floor(x / TC)},${Math.floor(z / TC)}`
  let best = null, bestD = Infinity
  const tops = []
  for (const tri of tgrid.get(k) ?? []) {
    const [a, b, c] = tri
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if (Math.abs(d) < 1e-9) continue
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
    const l3 = 1 - l1 - l2
    if (l1 >= -0.02 && l2 >= -0.02 && l3 >= -0.02) { tops.push(l1 * a[1] + l2 * b[1] + l3 * c[1]); continue }
    for (const v of tri) { const dv = Math.hypot(v[0] - x, v[2] - z); if (dv < bestD) { bestD = dv; best = v[1] } }
  }
  if (tops.length) return tops
  return bestD < 12 ? [best] : []
}
// Where a bridge or a pit-exit tunnel crosses the track in the same material, a point
// has several surfaces; the lap keeps the one continuous with its neighbours. Two
// passes around the closed loop so the arbitrary first choice cannot stick.
const levelHeights = (pts) => {
  const opts = pts.map(heightsAt)
  let prev = opts[0].length ? Math.max(...opts[0]) : 0
  const out = new Array(pts.length).fill(null)
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < pts.length; i++) {
    const o = opts[i]
    if (!o.length) { out[i] = null; continue }
    let pick = o[0]; for (const y of o) if (Math.abs(y - prev) < Math.abs(pick - prev)) pick = y
    out[i] = pick; prev = pick
  }
  return out
}
let ys = levelHeights(line)
let missing = 0
for (let i = 0; i < ys.length; i++) if (ys[i] === null) { missing++; let j = 1; while (j < ys.length && ys[(i + j) % ys.length] === null) j++; ys[i] = ys[(i + j) % ys.length] ?? 0 }
ys = ys.map((_, i) => { let s = 0; for (let d = -2; d <= 2; d++) s += ys[(i + d + ys.length) % ys.length]; return s / 5 })
const every = Math.max(1, Math.round(cfg.controlSpacing / 2))
const control = line.filter((_, i) => i % every === 0).map(([x, z], k) => [+x.toFixed(1), +ys[k * every].toFixed(2), +z.toFixed(1)])
const controlWidths = halfWidths ? halfWidths.filter((_, i) => i % every === 0).map((v) => +v.toFixed(1)) : undefined
// Pit zone: the span of the lap that runs alongside pit asphalt.
let pitFeature = null
if (pitPts.length) {
  const pgrid = new Map()
  for (const q of pitPts) { const k = `${Math.floor(q[0] / TC)},${Math.floor(q[2] / TC)}`; (pgrid.get(k) ?? pgrid.set(k, []).get(k)).push(q) }
  const nearPit = (p) => { const cx = Math.floor(p[0] / TC), cz = Math.floor(p[1] / TC); for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const q of pgrid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(q[0] - p[0], q[2] - p[1]) < 30) return q; return null }
  const near = line.map(nearPit)
  // Runs of samples alongside pit asphalt; a model may carry several pit lanes
  // (Spa keeps its old Eau Rouge pits), so take the one closest to the start.
  const n = near.length
  const runs = new Map()
  let run = -1
  for (let i = 0; i < 2 * n; i++) { const f = !!near[i % n]; if (f && run < 0) run = i; if ((!f || i === 2 * n - 1) && run >= 0) { const len = Math.min(i - run, n); if (len * 2 > 120) runs.set(run % n, Math.max(runs.get(run % n) ?? 0, len)); run = -1 } }
  let bestS = -1, bestL = 0, bestD = Infinity
  for (const [s, len] of runs) { const m = (s + Math.floor(len / 2)) % n; const d = Math.min(m, n - m); if (d < bestD || (d === bestD && len > bestL)) { bestD = d; bestS = s; bestL = len } }
  if (bestL > 0) {
    const midI = (bestS + Math.floor(bestL / 2)) % n
    const q = near[midI], p = line[midI], nxt = line[(midI + 1) % n]
    const tx = nxt[0] - p[0], tz = nxt[1] - p[1]
    // right = up × tangent = (tz, -tx) in (x, z), matching TrackSpline
    const side = (q[0] - p[0]) * tz + (q[2] - p[1]) * -tx > 0 ? 1 : -1
    pitFeature = { type: 'pit', from: +(((bestS % n) * 2) / length).toFixed(3), to: +((((bestS + bestL) % n) * 2) / length).toFixed(3), side }
  }
}

// --- widths + bounds + optional map dump ------------------------------------------------------
const edgeDist = (p) => { const cx = cellX(p[0]), cz = cellZ(p[1]); for (let r = 0; r < 60; r++) { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; if (!at(grid, cx + dx, cz + dz)) return Math.hypot(dx, dz) * RES } } return 60 * RES }
const widths = line.filter((_, i) => i % 5 === 0).map((p) => 2 * edgeDist(p)).sort((a, b) => a - b)
let box = [Infinity, Infinity, -Infinity, -Infinity]
for (const p of line) box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])]
if (flags.includes('--map')) {
  const skelPts = []
  for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) skelPts.push([gx0 + x * RES, gz0 + z * RES])
  const wallPts = []
  if (wallGrid) for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (wallGrid[z * GW + x]) wallPts.push([gx0 + x * RES, gz0 + z * RES])
  fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-centreline.json`), JSON.stringify({ line, skeleton: skelPts, walls: wallPts, res: RES, walks: walkDebug, startIdx, road: roadTris.map((t) => t.map((v) => [+v[0].toFixed(1), +v[2].toFixed(1)])), pit: pitPts.filter((_, i) => i % 3 === 0).map((q) => [+q[0].toFixed(1), +q[2].toFixed(1)]) }))
}

// --- rebuild hierarchy: one node per class -------------------------------------------------
if (pointsOnly) {
  const features = pitFeature ? [pitFeature] : []
  fs.mkdirSync(path.dirname(pointsOutPath), { recursive: true })
  fs.writeFileSync(pointsOutPath, JSON.stringify({ generatedBy: 'tools/asset-pipeline/prepare-track.mjs', lapMetres: Math.round(length), features, points: control, ...(controlWidths ? { halfWidths: controlWidths } : {}) }) + '\n')
  console.log(`lap ${length.toFixed(0)} m (${cfg.direction}), ${control.length} control points → ${pointsOutPath}; ${startNote}; elevation ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} m`)
  if (pitFeature) console.log(`pit lane: t ${pitFeature.from}..${pitFeature.to} on side ${pitFeature.side > 0 ? 'right' : 'left'}`)
  process.exit(0)
}
for (const child of scene.listChildren()) scene.removeChild(child)
const targets = {}
for (const cls of CLASSES) for (const shadow of [true, false]) { const name = shadow ? cls : `${cls}_noshadow`; const n = doc.createNode(name); scene.addChild(n); targets[name] = n }
const groups = new Map()
for (const p of prims) { const t = targets[p.noShadow ? `${p.cls}_noshadow` : p.cls]; (groups.get(t) ?? groups.set(t, []).get(t)).push(p.prim) }
for (const mesh of root.listMeshes()) mesh.dispose()
let drawCalls = 0, tris = 0
const trisOf = (p) => (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3
for (const [target, list] of groups) {
  const byKey = new Map()
  for (const p of list) { const k = [p.getMaterial()?.getName(), p.getMode(), p.listSemantics().join(','), p.getIndices() ? 'i' : 'n'].join('|'); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(p) }
  const mesh = doc.createMesh(target.getName())
  for (const same of byKey.values()) {
    const joined = same.length > 1 ? joinPrimitives(same) : same[0]
    if (same.length > 1) for (const p of same) p.dispose()
    mesh.addPrimitive(joined)
    drawCalls++
    tris += trisOf(joined)
  }
  target.setMesh(mesh)
}
for (const [name, node] of Object.entries(targets)) if (!node.getMesh()) { scene.removeChild(node); node.dispose(); delete targets[name] }
if (cfg.decimate) {
  await MeshoptSimplifier.ready
  for (const [cls, ratio] of Object.entries(cfg.decimate)) {
    for (const name of [cls, `${cls}_noshadow`]) {
      const mesh = targets[name]?.getMesh()
      if (!mesh) continue
      const before = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
      // Per primitive: the document-wide simplify() has no filter and would
      // decimate the lap surface too (it once cut Spa's road to 5 % of its triangles).
      for (const p of mesh.listPrimitives()) {
        weldPrimitive(p)
        const q = simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: 0.002 })
        if (q !== p) { mesh.removePrimitive(p); mesh.addPrimitive(q); p.dispose() }
      }
      const after = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
      tris += after - before
      console.log(`decimated ${name}: ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tris`)
    }
  }
}
for (const mat of root.listMaterials()) {
  const tr = mat.getExtension('KHR_materials_transmission')
  if (tr) { mat.setExtension('KHR_materials_transmission', null); tr.dispose(); const c = mat.getBaseColorFactor(); mat.setAlphaMode('BLEND').setBaseColorFactor([c[0], c[1], c[2], Math.min(c[3], 0.45)]) }
  for (const o of cfg.materials ?? []) {
    if (!o.match.test(mat.getName())) continue
    if (o.alphaMode) mat.setAlphaMode(o.alphaMode)
    if (o.alphaCutoff !== undefined) mat.setAlphaCutoff(o.alphaCutoff)
    if (o.doubleSided !== undefined) mat.setDoubleSided(o.doubleSided)
  }
}
root.getAsset().copyright = cfg.credit
root.getAsset().generator = 'apex prepare-track.mjs (glTF-Transform)'

// --- textures ------------------------------------------------------------------
if (!skipTextures) {
  const isColor = (slots) => slots.some((s) => /baseColor|emissive/i.test(s))
  const isNormal = (slots) => slots.some((s) => /normal/i.test(s))
  for (const [pattern, size] of [[/baseColor|emissive/i, cfg.textures.color], [/normal/i, cfg.textures.normal], [/metallicRoughness|occlusion|specular/i, cfg.textures.other]]) {
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [size, size], slots: pattern }))
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ktx2-'))
  const basisu = path.resolve('node_modules/basisu/bin', process.platform, process.arch, 'basisu')
  let n = 0, bytesTotal = 0
  for (const tex of root.listTextures()) {
    const slots = listTextureSlots(tex)
    const png = path.join(tmp, `${n}.png`), ktx = path.join(tmp, `${n}.ktx2`)
    fs.writeFileSync(png, tex.getImage())
    // basisu needs dimensions divisible by 4; pad tiny textures by resizing.
    const meta = await sharp(png).metadata()
    if (meta.width % 4 || meta.height % 4 || meta.width < 4 || meta.height < 4) await sharp(png).resize(Math.max(4, Math.ceil(meta.width / 4) * 4), Math.max(4, Math.ceil(meta.height / 4) * 4), { fit: 'fill' }).toFile(png + '.p.png').then(() => fs.renameSync(png + '.p.png', png))
    const args = ['-file', png, '-output_file', ktx, '-ktx2', '-mipmap', '-mip_filter', 'kaiser']
    if (isNormal(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '0.75', '-normal_map', '-mip_renorm')
    else if (isColor(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0')
    else args.push('-linear', '-q', '200', '-comp_level', '2')
    try {
      execFileSync(basisu, args, { stdio: 'pipe' })
      const bytes = fs.readFileSync(ktx)
      bytesTotal += bytes.length
      tex.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2').setURI('')
    } catch (err) {
      console.warn(`  texture #${n} (${slots}) kept as PNG: ${String(err.stderr || err.message).split('\n')[0].slice(0, 120)}`)
    }
    n++
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`  ${n} textures → ${(bytesTotal / 1048576).toFixed(1)} MB KTX2`)
}
await doc.transform(dedup(), prune({ keepLeaves: true }), weld(), draco({ method: 'edgebreaker', quantizePosition: 20, quantizeNormal: 10, quantizeTexcoord: 12 })) // 20 bits: ~2 mm over a 2 km circuit; 14 bits (13 cm) made the road bumpy and split stacked surfaces)
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
await io.write(outputPath, doc)

// --- report + data -----------------------------------------------------------------
const features = pitFeature ? [pitFeature] : []
fs.mkdirSync(path.dirname(pointsOutPath), { recursive: true })
fs.writeFileSync(pointsOutPath, JSON.stringify({ generatedBy: 'tools/asset-pipeline/prepare-track.mjs', lapMetres: Math.round(length), features, points: control, ...(controlWidths ? { halfWidths: controlWidths } : {}) }) + '\n')
console.log(`\n${outputPath}: ${(fs.statSync(outputPath).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(`lap ${length.toFixed(0)} m (${cfg.direction}), ${control.length} control points → ${pointsOutPath}; ${startNote}; elevation ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} m (${missing} samples off the mesh)`)
console.log(`road width along the line: min ${widths[0].toFixed(1)} median ${widths[widths.length >> 1].toFixed(1)} max ${widths[widths.length - 1].toFixed(1)} m; bounds x[${box[0].toFixed(0)}, ${box[2].toFixed(0)}] z[${box[1].toFixed(0)}, ${box[3].toFixed(0)}]`)
if (pitFeature) console.log(`pit lane: t ${pitFeature.from}..${pitFeature.to} on side ${pitFeature.side > 0 ? 'right' : 'left'}`)
else console.log('pit lane: none detected')
