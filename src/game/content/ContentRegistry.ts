import { TRACK_BY_ID, TRACK_CATALOG, type TrackDefinition } from '../tracks/TrackCatalog'
import { VEHICLE_BY_ID, VEHICLE_CATALOG } from '../vehicles/VehicleCatalog'
import type { VehicleSpec } from '../vehicles/VehicleSpec'

/** Local, typed content packs. Register before Engine.boot / profile loading. */
export interface ContentPack {
  id: string
  tracks?: TrackDefinition[]
  vehicles?: VehicleSpec[]
}

const installed = new Set<string>()
const validId = (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
const positive = (value: number) => Number.isFinite(value) && value > 0
const assetPath = (file: string) => file.startsWith('assets/') && !file.includes('..') && !file.includes('://')

/** Validate everything before changing catalogs: a bad pack never installs half-way. */
export function registerContentPack(pack: ContentPack): void {
  if (!validId(pack.id) || installed.has(pack.id)) throw new Error(`Invalid or duplicate content pack: ${pack.id}`)
  const trackIds = new Set(Object.keys(TRACK_BY_ID))
  const vehicleIds = new Set(Object.keys(VEHICLE_BY_ID))
  for (const track of pack.tracks ?? []) {
    if (!validId(track.id) || trackIds.has(track.id)) throw new Error(`Duplicate or invalid track: ${track.id}`)
    if (track.points.length < 4 || track.points.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(v)))) throw new Error(`Invalid centreline: ${track.id}`)
    if (!positive(track.width) || !Number.isFinite(track.unlockLevel) || track.unlockLevel < 0) throw new Error(`Invalid track dimensions/unlock: ${track.id}`)
    if (track.halfWidths && (track.halfWidths.length !== track.points.length || track.halfWidths.some((v) => !positive(v)))) throw new Error(`Invalid track widths: ${track.id}`)
    if (track.model && (!assetPath(track.model.file) || !track.model.credit.trim())) throw new Error(`Track model needs a local asset and credit: ${track.id}`)
    trackIds.add(track.id)
  }
  for (const vehicle of pack.vehicles ?? []) {
    if (!validId(vehicle.id) || vehicleIds.has(vehicle.id)) throw new Error(`Duplicate or invalid car: ${vehicle.id}`)
    if (![vehicle.mass, vehicle.comHeight, vehicle.body.wheelRadius, vehicle.body.wheelbase, vehicle.suspension.stiffness, vehicle.suspension.restLength].every(positive)) throw new Error(`Invalid vehicle physics: ${vehicle.id}`)
    if (vehicle.model && (!assetPath(vehicle.model.file) || !vehicle.model.credit.trim())) throw new Error(`Car model needs a local asset and credit: ${vehicle.id}`)
    vehicleIds.add(vehicle.id)
  }
  for (const track of pack.tracks ?? []) {
    TRACK_CATALOG.push(track)
    TRACK_BY_ID[track.id] = track
  }
  for (const vehicle of pack.vehicles ?? []) {
    VEHICLE_CATALOG.push(vehicle)
    VEHICLE_BY_ID[vehicle.id] = vehicle
  }
  installed.add(pack.id)
}

export const installedContentPacks = (): readonly string[] => [...installed]
