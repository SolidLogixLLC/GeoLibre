import type { GeoLibreSearchProvider, GeoLibreSearchResult } from "@geolibre/plugins";

/** Longest a provider may take before the search box stops waiting for it. */
export const SEARCH_PROVIDER_TIMEOUT_MS = 250;
/** Most results the search box lists per provider, whatever the provider asks for. */
export const MAX_PROVIDER_RESULTS = 5;
/** Shortest trimmed query a provider is asked about unless it sets its own. */
export const DEFAULT_PROVIDER_MIN_QUERY_LENGTH = 2;

/** One provider's answer to a query, ready to render as a titled group. */
export interface SearchProviderGroup {
  providerId: string;
  title: string;
  results: GeoLibreSearchResult[];
}

/**
 * A result is usable only if it has a label and names a place on the globe. An
 * unusable `bbox` or `zoom` is dropped rather than rejecting the whole result,
 * so the map then falls back to flying to the point.
 */
function normalizeResult(value: unknown): GeoLibreSearchResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<GeoLibreSearchResult>;
  if (
    typeof result.id !== "string" ||
    typeof result.label !== "string" ||
    result.label.length === 0 ||
    typeof result.lng !== "number" ||
    !Number.isFinite(result.lng) ||
    typeof result.lat !== "number" ||
    !Number.isFinite(result.lat)
  ) {
    return null;
  }
  const { bbox, zoom } = result;
  const usableBbox =
    Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => Number.isFinite(n));
  const usableZoom = typeof zoom === "number" && Number.isFinite(zoom);
  return {
    ...result,
    bbox: usableBbox ? bbox : undefined,
    zoom: usableZoom ? zoom : undefined,
  } as GeoLibreSearchResult;
}

/** A provider's title, resolved when read so a getter can follow the language. */
export function resolveProviderTitle(provider: GeoLibreSearchProvider): string {
  try {
    const title = typeof provider.title === "function" ? provider.title() : provider.title;
    if (typeof title === "string" && title.trim().length > 0) return title;
  } catch {
    // A throwing getter falls back to the id, like a missing title.
  }
  return provider.id;
}

/**
 * Ask one provider about `query`, or resolve to `null` when it throws, rejects,
 * returns something that is not a list, or has not answered within `timeoutMs`.
 * A provider that fails only loses its own group.
 */
async function queryProvider(
  provider: GeoLibreSearchProvider,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<GeoLibreSearchResult[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    // Starting the call inside a promise turns a synchronous throw into a
    // rejection, so both failure shapes take the same path.
    const answer = await Promise.race([
      Promise.resolve().then(() => provider.search(query, { signal })),
      timeout,
    ]);
    if (!Array.isArray(answer)) return null;
    const requested = provider.maxResults;
    const limit =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(1, Math.min(MAX_PROVIDER_RESULTS, Math.floor(requested)))
        : MAX_PROVIDER_RESULTS;
    const results: GeoLibreSearchResult[] = [];
    for (const item of answer) {
      const result = normalizeResult(item);
      if (result) results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query every provider that accepts `query` in parallel and return the groups
 * that produced results, in provider order. A provider that throws, rejects or
 * times out is skipped without affecting the others; so is one whose
 * `minQueryLength` the query does not reach. `signal` is shared by all of them.
 */
export async function querySearchProviders(
  providers: readonly GeoLibreSearchProvider[],
  query: string,
  signal: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<SearchProviderGroup[]> {
  const timeoutMs = options.timeoutMs ?? SEARCH_PROVIDER_TIMEOUT_MS;
  const eligible = providers.filter(
    (provider) => query.length >= (provider.minQueryLength ?? DEFAULT_PROVIDER_MIN_QUERY_LENGTH),
  );
  const answers = await Promise.all(
    eligible.map((provider) => queryProvider(provider, query, signal, timeoutMs)),
  );
  const groups: SearchProviderGroup[] = [];
  eligible.forEach((provider, index) => {
    const results = answers[index];
    if (results && results.length > 0) {
      groups.push({
        providerId: provider.id,
        title: resolveProviderTitle(provider),
        results,
      });
    }
  });
  return groups;
}
