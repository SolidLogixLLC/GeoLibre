import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import {
  __resetSearchProviderRegistryForTests,
  getSearchProvidersSnapshot,
  listSearchProviders,
  registerSearchProvider,
  subscribeSearchProviders,
  unregisterSearchProvider,
  unregisterSearchProvidersByOwner,
} from "../packages/plugins/src/search-provider-registry";
import type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  GeoLibreSearchProvider,
  GeoLibreSearchResult,
} from "../packages/plugins/src/types";
import {
  MAX_PROVIDER_RESULTS,
  querySearchProviders,
  resolveProviderTitle,
} from "../apps/geolibre-desktop/src/lib/search-providers";

function testProvider(patch: Partial<GeoLibreSearchProvider> = {}): GeoLibreSearchProvider {
  return {
    id: "sites",
    title: "Sites",
    search: () => [],
    ...patch,
  };
}

function testResult(id: string, patch: Partial<GeoLibreSearchResult> = {}): GeoLibreSearchResult {
  return { id, label: `Result ${id}`, lng: -100, lat: 40, ...patch };
}

function testPlugin(patch: Partial<GeoLibrePlugin> = {}): GeoLibrePlugin {
  return {
    id: "search-plugin",
    name: "Search plugin",
    version: "0.1.0",
    activate: () => undefined,
    deactivate: () => undefined,
    ...patch,
  };
}

const signal = new AbortController().signal;

describe("search-provider registry", () => {
  afterEach(() => __resetSearchProviderRegistryForTests());

  it("registers, replaces, and unregisters providers", () => {
    registerSearchProvider(testProvider());
    assert.equal(listSearchProviders().length, 1);
    // Re-registering an id replaces the provider rather than duplicating it.
    const unregisterSecond = registerSearchProvider(testProvider({ title: "Sites 2" }));
    assert.equal(listSearchProviders().length, 1);
    assert.equal(listSearchProviders()[0].title, "Sites 2");
    unregisterSecond();
    assert.equal(listSearchProviders().length, 0);
  });

  it("does not let a stale disposer evict a newer registration", () => {
    const staleDispose = registerSearchProvider(testProvider({ title: "Old" }));
    registerSearchProvider(testProvider({ title: "New" }));
    staleDispose();
    assert.equal(listSearchProviders().length, 1);
    assert.equal(listSearchProviders()[0].title, "New");
  });

  it("rejects a provider without an id, a title, or a search function", () => {
    assert.throws(() => registerSearchProvider(testProvider({ id: "" })), /non-empty id/);
    assert.throws(() => registerSearchProvider(testProvider({ title: "  " })), /title/);
    assert.throws(
      () => registerSearchProvider(testProvider({ search: undefined as never })),
      /search function/,
    );
    assert.equal(listSearchProviders().length, 0);
  });

  it("keeps the snapshot identity stable between mutations and notifies subscribers", () => {
    let notified = 0;
    const unsubscribe = subscribeSearchProviders(() => {
      notified += 1;
    });
    const empty = getSearchProvidersSnapshot();
    assert.equal(getSearchProvidersSnapshot(), empty);
    registerSearchProvider(testProvider());
    const after = getSearchProvidersSnapshot();
    assert.notEqual(after, empty);
    assert.equal(getSearchProvidersSnapshot().providers, after.providers);
    assert.equal(notified, 1);
    // Removing an id that is not registered changes nothing.
    unregisterSearchProvider("missing");
    assert.equal(notified, 1);
    unsubscribe();
    unregisterSearchProvider("sites");
    assert.equal(notified, 1);
  });

  it("drops only the providers a given owner registered", () => {
    registerSearchProvider(testProvider({ id: "a" }), "plugin-a");
    registerSearchProvider(testProvider({ id: "b" }), "plugin-b");
    registerSearchProvider(testProvider({ id: "c" }));
    unregisterSearchProvidersByOwner("plugin-a");
    assert.deepEqual(
      listSearchProviders().map((provider) => provider.id),
      ["b", "c"],
    );
  });
});

describe("PluginManager search provider scoping", () => {
  afterEach(() => __resetSearchProviderRegistryForTests());

  it("tags a provider with the activating plugin's id on the real registry", () => {
    const manager = new PluginManager();
    const realApp = { registerSearchProvider } as unknown as GeoLibreAppAPI;
    manager.register(
      testPlugin({
        activate: (api) => void api.registerSearchProvider?.(testProvider()),
      }),
    );
    manager.activate("search-plugin", realApp);

    const { entries } = getSearchProvidersSnapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ownerPluginId, "search-plugin");
  });

  it("drops a plugin's providers when it is deactivated, even if it forgets to", () => {
    const manager = new PluginManager();
    const realApp = { registerSearchProvider } as unknown as GeoLibreAppAPI;
    manager.register(
      testPlugin({
        activate: (api) => void api.registerSearchProvider?.(testProvider()),
        // A plugin that never calls the disposer it was handed.
        deactivate: () => undefined,
      }),
    );
    manager.register(
      testPlugin({
        id: "other-plugin",
        activate: (api) => void api.registerSearchProvider?.(testProvider({ id: "other" })),
      }),
    );
    manager.activate("search-plugin", realApp);
    manager.activate("other-plugin", realApp);
    assert.equal(listSearchProviders().length, 2);

    manager.deactivate("search-plugin", realApp);

    assert.deepEqual(
      listSearchProviders().map((provider) => provider.id),
      ["other"],
    );
  });

  it("drops a plugin's providers when it is unregistered", () => {
    const manager = new PluginManager();
    const realApp = { registerSearchProvider } as unknown as GeoLibreAppAPI;
    manager.register(
      testPlugin({
        activate: (api) => void api.registerSearchProvider?.(testProvider()),
      }),
    );
    manager.activate("search-plugin", realApp);
    manager.unregister("search-plugin", realApp);
    assert.equal(listSearchProviders().length, 0);
  });

  it("is a no-op on a host without the hook", () => {
    const manager = new PluginManager();
    let registered: (() => void) | undefined | "unset" = "unset";
    manager.register(
      testPlugin({
        activate: (api) => {
          registered = api.registerSearchProvider?.(testProvider());
        },
      }),
    );
    manager.activate("search-plugin", {} as GeoLibreAppAPI);
    assert.equal(registered, undefined);
  });
});

describe("querySearchProviders", () => {
  it("returns a group per provider that answered, in provider order", async () => {
    const groups = await querySearchProviders(
      [
        testProvider({ id: "a", title: "A", search: () => [testResult("1")] }),
        testProvider({ id: "b", title: () => "B", search: async () => [testResult("2")] }),
        testProvider({ id: "c", title: "C", search: () => [] }),
      ],
      "kil",
      signal,
    );
    assert.deepEqual(
      groups.map((group) => [group.providerId, group.title, group.results.length]),
      [
        ["a", "A", 1],
        ["b", "B", 1],
      ],
    );
  });

  it("skips a provider that throws, rejects, or returns a non-list", async () => {
    const groups = await querySearchProviders(
      [
        testProvider({
          id: "sync-throw",
          search: () => {
            throw new Error("boom");
          },
        }),
        testProvider({ id: "reject", search: () => Promise.reject(new Error("nope")) }),
        testProvider({ id: "garbage", search: (() => "not a list") as never }),
        testProvider({ id: "fine", search: () => [testResult("1")] }),
      ],
      "kil",
      signal,
    );
    assert.deepEqual(
      groups.map((group) => group.providerId),
      ["fine"],
    );
  });

  it("stops waiting for a provider that has not answered in time", async () => {
    const started = Date.now();
    const groups = await querySearchProviders(
      [
        testProvider({ id: "hangs", search: () => new Promise<GeoLibreSearchResult[]>(() => {}) }),
        testProvider({ id: "fine", search: () => [testResult("1")] }),
      ],
      "kil",
      signal,
      { timeoutMs: 30 },
    );
    assert.deepEqual(
      groups.map((group) => group.providerId),
      ["fine"],
    );
    assert.ok(Date.now() - started < 1000);
  });

  it("caps results at the host limit and honors a smaller maxResults", async () => {
    const many = Array.from({ length: 9 }, (_, index) => testResult(String(index)));
    const [capped, small] = await querySearchProviders(
      [
        testProvider({ id: "capped", search: () => many, maxResults: 50 }),
        testProvider({ id: "small", search: () => many, maxResults: 2 }),
      ],
      "kil",
      signal,
    );
    assert.equal(capped.results.length, MAX_PROVIDER_RESULTS);
    assert.equal(small.results.length, 2);
  });

  it("respects minQueryLength, defaulting to two characters", async () => {
    let asked = 0;
    const search = () => {
      asked += 1;
      return [testResult("1")];
    };
    await querySearchProviders([testProvider({ search })], "k", signal);
    assert.equal(asked, 0);
    await querySearchProviders([testProvider({ search, minQueryLength: 4 })], "kil", signal);
    assert.equal(asked, 0);
    await querySearchProviders([testProvider({ search, minQueryLength: 4 })], "kilb", signal);
    assert.equal(asked, 1);
  });

  it("drops malformed results and unusable bbox or zoom values", async () => {
    const [group] = await querySearchProviders(
      [
        testProvider({
          search: () =>
            [
              testResult("ok", { bbox: [-1, -1, 1, 1], zoom: 14 }),
              testResult("bad-bbox", { bbox: [1, 2] as never, zoom: Number.NaN }),
              { id: "no-label", label: "", lng: 1, lat: 1 },
              { id: "no-lng", label: "x", lng: Number.NaN, lat: 1 },
              null,
            ] as GeoLibreSearchResult[],
        }),
      ],
      "kil",
      signal,
    );
    assert.deepEqual(
      group.results.map((result) => result.id),
      ["ok", "bad-bbox"],
    );
    assert.deepEqual(group.results[0].bbox, [-1, -1, 1, 1]);
    assert.equal(group.results[0].zoom, 14);
    assert.equal(group.results[1].bbox, undefined);
    assert.equal(group.results[1].zoom, undefined);
  });

  it("passes the shared signal and the trimmed query through", async () => {
    const controller = new AbortController();
    const seen: Array<[string, boolean]> = [];
    await querySearchProviders(
      [
        testProvider({
          id: "a",
          search: (query, context) => {
            seen.push([query, context.signal === controller.signal]);
            return [];
          },
        }),
        testProvider({
          id: "b",
          search: (query, context) => {
            seen.push([query, context.signal === controller.signal]);
            return [];
          },
        }),
      ],
      "kilby",
      controller.signal,
    );
    assert.deepEqual(seen, [
      ["kilby", true],
      ["kilby", true],
    ]);
  });

  it("falls back to the id when a title getter throws or is empty", () => {
    assert.equal(
      resolveProviderTitle(
        testProvider({
          id: "sites",
          title: () => {
            throw new Error("no language yet");
          },
        }),
      ),
      "sites",
    );
    assert.equal(resolveProviderTitle(testProvider({ id: "sites", title: () => "" })), "sites");
  });
});
