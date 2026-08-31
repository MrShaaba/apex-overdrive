import { LocalNetworkProvider } from './LocalNetworkProvider'
import type { NetworkProvider } from './types'

/** Singleton network provider. Swap for a remote implementation at bootstrap. */
export let network: NetworkProvider = new LocalNetworkProvider()

export function setNetworkProvider(provider: NetworkProvider): void {
  network = provider
}

export * from './types'
