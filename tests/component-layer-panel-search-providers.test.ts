import { act, fireEvent, mockFetch, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";
import type { GeoLibreSearchProvider, GeoLibreSearchResult } from "@geolibre/plugins";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { LayerPanelPlaceSearch } = await import(
  "../apps/geolibre-desktop/src/components/panels/LayerPanelPlaceSearch"
);
const { __resetSearchProviderRegistryForTests, registerSearchProvider } = await import(
  "../packages/plugins/src/search-provider-registry"
);

afterEach(() => __resetSearchProviderRegistryForTests());

/** A map engine that records what the search box asks of it, in order. */
function fakeEngine(zoom = 5) {
  const calls: string[] = [];
  const engine = {
    kind: "maplibre",
    readView: () => ({ center: [0, 0], zoom }),
    showSearchResult: (geometry: { type: string; coordinates: unknown }) => {
      calls.push(`marker:${JSON.stringify(geometry.coordinates)}`);
      return () => calls.push("marker-disposed");
    },
    flyTo: (camera: { center: [number, number]; zoom: number }) => {
      calls.push(`flyTo:${JSON.stringify(camera.center)}@${camera.zoom}`);
    },
    fitBounds: (bounds: number[]) => {
      calls.push(`fitBounds:${JSON.stringify(bounds)}`);
    },
  } as unknown as MapEngine;
  return { engine, calls };
}

function result(id: string, patch: Partial<GeoLibreSearchResult> = {}): GeoLibreSearchResult {
  return { id, label: `Kilby ${id}`, lng: -100.5, lat: 40.25, ...patch };
}

function provider(patch: Partial<GeoLibreSearchProvider> = {}): GeoLibreSearchProvider {
  return {
    id: "sites",
    title: "Facilities",
    search: () => [result("Site")],
    ...patch,
  };
}

/** Answer the geocoder with one Nominatim-shaped place. */
function serveOnePlace(): void {
  useAppStore.setState((state) => ({
    preferences: {
      ...state.preferences,
      // A host that is not the public Nominatim one, so the geocoder debounce
      // stays at its 500 ms floor instead of the 1.1 s request spacing.
      geocoding: {
        ...state.preferences.geocoding,
        forwardEndpoint: "https://geocoder.test/search",
      },
    },
  }));
  mockFetch(async () =>
    Response.json([{ lat: "10", lon: "20", display_name: "Kilby Place", importance: 0.5 }]),
  );
}

function renderSearch(engine: MapEngine | null = null) {
  return render(createElement(LayerPanelPlaceSearch, { mapControllerRef: { current: engine } }));
}

/** Focus the box and type `text`, the way a user would. */
function type(text: string): HTMLInputElement {
  const input = screen.getByRole("combobox") as HTMLInputElement;
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
  return input;
}

function optionTexts(): string[] {
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

function groupNames(): string[] {
  return screen.queryAllByRole("group").map((group) => group.getAttribute("aria-label") ?? "");
}

describe("LayerPanelPlaceSearch plugin search providers", () => {
  it("lists a provider's results as a titled group", async () => {
    registerSearchProvider(
      provider({ search: () => [result("Site", { detail: "Landfill · Utah" })] }),
    );
    renderSearch();

    type("kil");

    await waitFor(() => assert.deepEqual(groupNames(), ["Facilities"]));
    assert.deepEqual(optionTexts(), ["Kilby SiteLandfill · Utah"]);
  });

  it("places provider groups between the layer-feature groups and Places", async () => {
    serveOnePlace();
    useAppStore.setState({
      layers: [
        geojsonLayer({
          id: "roads",
          name: "Roads",
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: 1,
                properties: { name: "Kilby Road" },
                geometry: { type: "Point", coordinates: [1, 2] },
              },
            ],
          },
        }),
      ],
    });
    registerSearchProvider(provider());
    renderSearch();

    type("kilby");

    await waitFor(() => assert.equal(optionTexts().length, 3), { timeout: 3000 });
    assert.deepEqual(groupNames(), ["Roads", "Facilities"]);
    assert.deepEqual(
      optionTexts().map((text) => text.slice(0, 10)),
      ["Kilby Road", "Kilby Site", "Kilby Plac"],
    );
    assert.ok(screen.getByRole("listbox").textContent?.includes("Places"));
  });

  it("moves the map, drops the marker, then calls onSelect", async () => {
    const { engine, calls } = fakeEngine(5);
    const selected: string[] = [];
    registerSearchProvider(
      provider({
        search: () => [result("Site", { detail: "Landfill" })],
        onSelect: (picked) => {
          calls.push("onSelect");
          selected.push(picked.id);
        },
      }),
    );
    renderSearch(engine);
    const input = type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 1));

    fireEvent.mouseDown(screen.getByRole("option"));

    // Marker first, then the camera (zoom is at least 12), then the plugin hook.
    assert.deepEqual(calls, ["marker:[-100.5,40.25]", "flyTo:[-100.5,40.25]@12", "onSelect"]);
    assert.deepEqual(selected, ["Site"]);
    assert.equal(input.value, "Kilby Site");
    assert.equal(screen.queryAllByRole("option").length, 0);
  });

  it("keeps a closer current zoom and honors a result's own zoom", async () => {
    const closer = fakeEngine(15);
    registerSearchProvider(provider());
    const { unmount } = renderSearch(closer.engine);
    type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 1));
    fireEvent.mouseDown(screen.getByRole("option"));
    assert.ok(closer.calls.includes("flyTo:[-100.5,40.25]@15"));
    unmount();
    __resetSearchProviderRegistryForTests();

    const explicit = fakeEngine(15);
    registerSearchProvider(provider({ search: () => [result("Site", { zoom: 9 })] }));
    renderSearch(explicit.engine);
    type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 1));
    fireEvent.mouseDown(screen.getByRole("option"));
    assert.ok(explicit.calls.includes("flyTo:[-100.5,40.25]@9"));
  });

  it("fits the map to a result's bbox instead of flying to its point", async () => {
    const { engine, calls } = fakeEngine();
    registerSearchProvider(
      provider({ search: () => [result("Site", { bbox: [-101, 40, -100, 41] })] }),
    );
    renderSearch(engine);
    type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 1));

    fireEvent.mouseDown(screen.getByRole("option"));

    assert.deepEqual(calls, ["marker:[-100.5,40.25]", "fitBounds:[-101,40,-100,41]"]);
  });

  it("selects from the keyboard and reaches the provider row through aria-activedescendant", async () => {
    const { engine } = fakeEngine();
    const selected: string[] = [];
    registerSearchProvider(
      provider({
        search: () => [result("One"), result("Two")],
        onSelect: (picked) => selected.push(picked.id),
      }),
    );
    renderSearch(engine);
    const input = type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 2));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const activeId = input.getAttribute("aria-activedescendant");
    assert.ok(activeId);
    assert.equal(document.getElementById(activeId)?.textContent, "Kilby Two");
    fireEvent.keyDown(input, { key: "Enter" });

    assert.deepEqual(selected, ["Two"]);
  });

  it("still shows Places when a provider throws or hangs", async () => {
    serveOnePlace();
    registerSearchProvider(
      provider({
        id: "throws",
        title: "Broken",
        search: () => {
          throw new Error("boom");
        },
      }),
    );
    registerSearchProvider(
      provider({
        id: "hangs",
        title: "Slow",
        search: () => new Promise<GeoLibreSearchResult[]>(() => {}),
      }),
    );
    registerSearchProvider(provider({ id: "fine" }));
    renderSearch();

    type("kilby");

    await waitFor(() => assert.equal(optionTexts().length, 2), { timeout: 3000 });
    assert.deepEqual(groupNames(), ["Facilities"]);
    assert.deepEqual(
      optionTexts().map((text) => text.slice(0, 10)),
      ["Kilby Site", "Kilby Plac"],
    );
  });

  it("does not query providers for a coordinate or an H3 cell", async () => {
    let asked = 0;
    registerSearchProvider(
      provider({
        search: () => {
          asked += 1;
          return [result("Site")];
        },
      }),
    );
    renderSearch();

    type("45.5, -122.6");
    await waitFor(() => assert.equal(optionTexts().length, 1));
    // Wait past the providers' debounce; a query would have landed by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(asked, 0);
    assert.equal(groupNames().length, 0);
    assert.match(optionTexts()[0], /45\.5/);

    type("8928308280fffff");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(asked, 0);
    assert.equal(groupNames().length, 0);
  });

  it("does not offer a plugin's results once its provider is unregistered", async () => {
    const dispose = registerSearchProvider(provider());
    renderSearch();
    type("kil");
    await waitFor(() => assert.equal(optionTexts().length, 1));

    act(() => dispose());
    type("kilb");

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(groupNames().length, 0);
  });

  it("looks exactly as before when no provider is registered", async () => {
    serveOnePlace();
    renderSearch();

    type("kilby");

    await waitFor(() => assert.equal(optionTexts().length, 1), { timeout: 3000 });
    assert.deepEqual(optionTexts(), ["Kilby Place"]);
    // No group wrapper and no "Places" heading: the list is the places alone.
    assert.deepEqual(groupNames(), []);
    assert.ok(!screen.getByRole("listbox").textContent?.includes("Places"));
  });
});
