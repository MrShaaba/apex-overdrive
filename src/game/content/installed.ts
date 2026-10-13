import { registerContentPack, type ContentPack } from './ContentRegistry'

// Import local packs here. Menus, profile unlocks and race setup use the same catalogs.
const packs: ContentPack[] = []
export function registerInstalledContent(): void {
  for (const pack of packs) registerContentPack(pack)
}
