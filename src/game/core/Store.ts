/**
 * Minimal observable store with selector support. Designed for
 * `useSyncExternalStore` so React screens re-render only when the slice they read
 * changes. Engine systems write to it; the UI reads from it.
 */

export type Listener = () => void

export class Store<T extends object> {
  private state: T
  private readonly listeners = new Set<Listener>()

  constructor(initial: T) {
    this.state = initial
  }

  get(): T {
    return this.state
  }

  set(patch: Partial<T> | ((prev: T) => Partial<T>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    let changed = false
    for (const key in next) {
      if (this.state[key] !== next[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = { ...this.state, ...next }
    for (const l of this.listeners) l()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
