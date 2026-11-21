import type { GeoLibreSearchProvider } from "./types";

/**
 * Imperative registry for plugin-owned search providers.
 *
 * A plugin contributes a source of results to the layer panel's search box.
 * Mirrors the open/subscribe pattern used by the other registries in this
 * package; the search box subscribes with `useSyncExternalStore` and queries
 * every registered provider as the user types.
 */

/**
 * A registered provider paired with the id of the plugin that registered it
 * (when the host scoped the registration to a plugin), so the host can drop a
 * plugin's providers when the plugin is deactivated.
 */
export interface SearchProviderEntry {
  provider: GeoLibreSearchProvider;
  ownerPluginId?: string;
}

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The `providers` and
 * `entries` array identities are stable between mutations so React can skip
 * re-renders; `version` is bumped on every change.
 */
export interface SearchProvidersSnapshot {
  providers: GeoLibreSearchProvider[];
  entries: SearchProviderEntry[];
  version: number;
}

const registry = new Map<string, SearchProviderEntry>();
const listeners = new Set<() => void>();

let version = 0;
let snapshot: SearchProvidersSnapshot = {
  providers: [],
  entries: [],
  version: 0,
};

function emit(): void {
  version += 1;
  const entries = [...registry.values()];
  snapshot = {
    providers: entries.map((entry) => entry.provider),
    entries,
    version,
  };
  for (const listener of listeners) {
    listener();
  }
}

function hasTitle(title: unknown): boolean {
  return typeof title === "function" || (typeof title === "string" && title.trim().length > 0);
}

/**
 * Register a search provider. Returns an unregister function (call it from the
 * plugin's `deactivate` hook). Re-registering the same id replaces the
 * provider, so a plugin can rebuild its provider as its state changes.
 *
 * `ownerPluginId` is injected by the host (the PluginManager scopes each
 * plugin's app API to its id); plugins call this with a single argument.
 */
export function registerSearchProvider(
  provider: GeoLibreSearchProvider,
  ownerPluginId?: string,
): () => void {
  if (!provider || typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("registerSearchProvider requires a provider with a non-empty id.");
  }
  // A title may be a getter (so it can follow the app language), so only its
  // shape is checked here; the search box resolves it when it renders.
  if (!hasTitle(provider.title)) {
    throw new Error(`Search provider "${provider.id}" must have a non-empty title.`);
  }
  if (typeof provider.search !== "function") {
    throw new Error(`Search provider "${provider.id}" must have a search function.`);
  }
  // The returned disposer only removes the provider while this exact
  // registration is still current, so a stale disposer cannot evict a newer
  // provider that reused the id.
  const entry: SearchProviderEntry = { provider, ownerPluginId };
  registry.set(provider.id, entry);
  emit();
  return () => {
    if (registry.get(provider.id) === entry) unregisterSearchProvider(provider.id);
  };
}

/** Remove a previously registered search provider. */
export function unregisterSearchProvider(id: string): void {
  if (!registry.delete(id)) return;
  emit();
}

/** Remove every search provider registered on behalf of `ownerPluginId`. */
export function unregisterSearchProvidersByOwner(ownerPluginId: string): void {
  let removed = false;
  for (const [id, entry] of registry) {
    if (entry.ownerPluginId === ownerPluginId) {
      registry.delete(id);
      removed = true;
    }
  }
  if (removed) emit();
}

/** All registered search providers, in registration order. */
export function listSearchProviders(): GeoLibreSearchProvider[] {
  return [...registry.values()].map((entry) => entry.provider);
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getSearchProvidersSnapshot(): SearchProvidersSnapshot {
  return snapshot;
}

/** Subscribe to search-provider registry changes. Returns an unsubscribe. */
export function subscribeSearchProviders(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetSearchProviderRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  version = 0;
  snapshot = { providers: [], entries: [], version: 0 };
}
