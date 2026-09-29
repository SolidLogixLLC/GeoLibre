import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { projectFromStore, useAppStore } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

/**
 * Coverage for control/briefs/plugin-api-transient-geojson.md: a plugin's
 * `addGeoJsonLayer({ transient: true })` keeps its features out of the
 * project file/autosave (via the existing `metadata.transientGeojson` strip
 * in `project.ts`), and `setGeoJsonLayerData` lets a plugin replace a GeoJSON
 * layer's features in place. The desktop bridge (`usePlugins.ts`) is thin
 * wiring over `store.addGeoJsonLayer`/`store.setGeoJsonLayerData` tested here
 * directly -- importing `usePlugins.ts` pulls in the whole built-in plugin
 * registry (see tests/plugin-query-api.test.ts), so its wiring is covered by
 * `npm run build`'s type check instead.
 */

const emptyFC = { type: "FeatureCollection" as const, features: [] };

function makeEmptyMapStub() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

describe("store.addGeoJsonLayer transient metadata", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Transient" });
    useAppStore.temporal.getState().clear();
  });

  it("sets metadata.transientGeojson when the bridge passes it at add time", () => {
    const id = useAppStore
      .getState()
      .addGeoJsonLayer("Faults", emptyFC, undefined, null, undefined, {
        transientGeojson: true,
      });
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.equal(layer.metadata.transientGeojson, true);
  });

  it("leaves metadata empty when no metadata is passed (stock behaviour unchanged)", () => {
    const id = useAppStore.getState().addGeoJsonLayer("Stock", emptyFC);
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.deepEqual(layer.metadata, {});
  });

  it("serializes a transient layer without geojson, and a non-transient layer with it", () => {
    const store = useAppStore.getState();
    store.addGeoJsonLayer("Transient", emptyFC, undefined, null, undefined, {
      transientGeojson: true,
    });
    store.addGeoJsonLayer("Stock", emptyFC);

    const project = projectFromStore(useAppStore.getState());

    const transient = project.layers.find((l) => l.name === "Transient");
    const stock = project.layers.find((l) => l.name === "Stock");
    assert.ok(transient);
    assert.ok(stock);
    assert.equal(transient.geojson, undefined);
    assert.notEqual(stock.geojson, undefined);
  });

  it("syncs a restored transient layer (no geojson) without throwing, and adds no source", () => {
    const id = useAppStore
      .getState()
      .addGeoJsonLayer("Restored transient", emptyFC, undefined, null, undefined, {
        transientGeojson: true,
      });
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    // Simulates reopening a project: the record has no `geojson`, matching
    // what prepareLayerForSave stripped and parseProject restored.
    const restored = { ...layer, geojson: undefined };

    const { map, calls } = makeEmptyMapStub();
    assert.doesNotThrow(() => syncLayer(map as never, restored));
    assert.equal(calls.find((c) => c.method === "addSource"), undefined);
    assert.equal(calls.find((c) => c.method === "addLayer"), undefined);
  });
});

describe("store.setGeoJsonLayerData", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Replace data" });
    useAppStore.temporal.getState().clear();
  });

  it("replaces features, keeping id, style, visibility, order and metadata", () => {
    const store = useAppStore.getState();
    const firstId = store.addGeoJsonLayer("First", emptyFC);
    const secondId = store.addGeoJsonLayer("Second", emptyFC, undefined, null, undefined, {
      transientGeojson: true,
    });
    store.setLayerVisibility(secondId, false);
    store.setLayerOpacity(secondId, 0.4);
    const before = useAppStore.getState().layers.find((l) => l.id === secondId);
    assert.ok(before);
    const orderBefore = useAppStore.getState().layers.map((l) => l.id);

    const replacement = {
      type: "FeatureCollection" as const,
      features: [
        { type: "Feature" as const, id: "f1", properties: { name: "New" }, geometry: null },
      ],
    };
    const ok = useAppStore.getState().setGeoJsonLayerData(secondId, replacement);
    assert.equal(ok, true);

    const after = useAppStore.getState().layers.find((l) => l.id === secondId);
    assert.ok(after);
    assert.deepEqual(after.geojson, replacement);
    assert.equal(after.id, before.id);
    assert.equal(after.name, before.name);
    assert.deepEqual(after.style, before.style);
    assert.equal(after.visible, false);
    assert.equal(after.opacity, 0.4);
    assert.deepEqual(after.metadata, { transientGeojson: true });
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      orderBefore,
    );
    // The other layer is untouched.
    const first = useAppStore.getState().layers.find((l) => l.id === firstId);
    assert.ok(first);
    assert.deepEqual(first.geojson, emptyFC);
  });

  it("returns false for an unknown layer id and leaves the store untouched", () => {
    const before = JSON.stringify(useAppStore.getState().layers);
    const ok = useAppStore.getState().setGeoJsonLayerData("no-such-layer", emptyFC);
    assert.equal(ok, false);
    assert.equal(JSON.stringify(useAppStore.getState().layers), before);
  });

  it("returns false for a non-GeoJSON layer and leaves it untouched", () => {
    const id = useAppStore.getState().addTileLayer("Imagery", {
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
    });
    const before = useAppStore.getState().layers.find((l) => l.id === id);
    const ok = useAppStore.getState().setGeoJsonLayerData(id, emptyFC);
    assert.equal(ok, false);
    const after = useAppStore.getState().layers.find((l) => l.id === id);
    assert.deepEqual(after, before);
  });
});
