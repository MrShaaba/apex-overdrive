/**
 * Storage abstraction. The game only talks to `StorageAdapter`; the concrete
 * backend is swappable. `LocalStorageAdapter` is used today; `CloudStorageAdapter`
 * documents the contract a remote backend must fulfil (auth token, conflict
 * resolution via `updatedAt`, etc.) so cloud saves can be dropped in later.
 */

export interface StorageAdapter {
  readonly name: string
  read<T>(key: string): Promise<T | null>
  write<T>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
  /** Approximate bytes used (for the diagnostics panel). */
  usage(): Promise<number>
}

const PREFIX = 'apex-overdrive:'

export class LocalStorageAdapter implements StorageAdapter {
  readonly name = 'localStorage'
  private readonly memoryFallback = new Map<string, string>()
  private available: boolean

  constructor() {
    this.available = this.probe()
  }

  private probe(): boolean {
    try {
      const k = `${PREFIX}__probe`
      localStorage.setItem(k, '1')
      localStorage.removeItem(k)
      return true
    } catch {
      return false
    }
  }

  async read<T>(key: string): Promise<T | null> {
    const raw = this.memoryFallback.get(key) ?? (this.available ? localStorage.getItem(PREFIX + key) : null)
    if (raw == null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    const raw = JSON.stringify(value)
    if (!this.available) {
      this.memoryFallback.set(key, raw)
      return
    }
    try {
      localStorage.setItem(PREFIX + key, raw)
      this.memoryFallback.delete(key)
    } catch (err) {
      // Quota exceeded: fall back to memory so the session keeps working.
      console.warn('[Storage] write failed, using in-memory fallback', err)
      this.memoryFallback.set(key, raw)
    }
  }

  async remove(key: string): Promise<void> {
    this.memoryFallback.delete(key)
    if (this.available) localStorage.removeItem(PREFIX + key)
  }

  async keys(): Promise<string[]> {
    const out: string[] = []
    if (this.available) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length))
      }
    }
    for (const k of this.memoryFallback.keys()) if (!out.includes(k)) out.push(k)
    return out
  }

  async usage(): Promise<number> {
    let bytes = 0
    for (const k of await this.keys()) {
      const raw = this.memoryFallback.get(k) ?? (this.available ? localStorage.getItem(PREFIX + k) : null)
      bytes += (raw?.length ?? 0) * 2
    }
    return bytes
  }
}

/** Pure in-memory adapter (used for tests / private browsing hard-failures). */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = 'memory'
  private readonly map = new Map<string, unknown>()
  async read<T>(key: string): Promise<T | null> {
    return (this.map.get(key) as T) ?? null
  }
  async write<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)))
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
  async usage(): Promise<number> {
    return 0
  }
}

export interface CloudStorageConfig {
  endpoint: string
  getAuthToken: () => Promise<string>
}

/**
 * Cloud adapter scaffold. Wraps a local adapter for offline-first behaviour and
 * describes the sync contract. Network calls are intentionally stubbed: wiring a
 * backend only requires implementing `push`/`pull`.
 */
export class CloudStorageAdapter implements StorageAdapter {
  readonly name = 'cloud'
  constructor(
    private readonly local: StorageAdapter,
    private readonly config: CloudStorageConfig,
  ) {}

  async read<T>(key: string): Promise<T | null> {
    return this.local.read<T>(key)
  }
  async write<T>(key: string, value: T): Promise<void> {
    await this.local.write(key, value)
    void this.push(key, value)
  }
  async remove(key: string): Promise<void> {
    await this.local.remove(key)
  }
  async keys(): Promise<string[]> {
    return this.local.keys()
  }
  async usage(): Promise<number> {
    return this.local.usage()
  }

  /** Upload a key to the remote. Replace with a real fetch when a backend exists. */
  protected async push<T>(key: string, value: T): Promise<void> {
    if (!this.config.endpoint) return
    void key
    // Example contract:
    // await fetch(`${this.config.endpoint}/save/${key}`, {
    //   method: 'PUT',
    //   headers: { Authorization: `Bearer ${await this.config.getAuthToken()}` },
    //   body: JSON.stringify({ value, updatedAt: Date.now() }),
    // })
    void value
  }
}
