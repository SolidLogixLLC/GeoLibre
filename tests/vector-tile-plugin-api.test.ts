import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { useAppStore } from "../packages/core/src/store";
import { syncLayer } from "../packages/map/src/layer-sync";
import { circleLayerId, fillLayerId, lineLayerId, vectorTileStyleLayerIds } from "@geolibre/map/style-layer-ids";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";
import { registerFeatureInteraction } from "../apps/geolibre-desktop/src/lib/feature-interaction";

/**
 * Host-side coverage for POC-04 (fork-vector-tile-plugin-api): a plugin's
 * `addVectorTileLayer` produces a plain `"vector-tiles"` GeoLibreLayer (built
 * directly in usePlugins.ts and added through store.addLayer -- see
 * control/briefs/fork-vector-tile-plugin-api.md), so these tests exercise that
 * layer shape through the same map-sync, legend, and hover paths a GeoJSON
 * layer goes through, without importing usePlugins.ts itself (which pulls in
 * the whole built-in plugin registry -- see tests/plugin-query-api.test.ts).
 */

interface FakeSource {
  tiles: string[];
  setTilesCalls: string[][];
  setTiles(tiles: string[]): void;
}

function makeMapStub(source?: FakeSource) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => source,
    once: () => undefined,
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

/** The shape usePlugins.ts's `addVectorTileLayer` builds from plugin options. */
function pluginVectorTileLayer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "faults-layer",
    name: "Quaternary faults",
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles: ["https://core.example/api/v1/tiles/faults/{z}/{x}/{y}.mvt"],
      sourceLayer: "faults",
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: { geometryType: "line" },
    ...overrides,
  } as unknown as GeoLibreLayer;
}

describe("addVectorTileLayer host contract — rendering", () => {
  it("is not control-managed: no externalNativeLayer/customLayerType metadata", () => {
    const layer = pluginVectorTileLayer();
    assert.equal(layer.metadata.externalNativeLayer, undefined);
    assert.equal(layer.metadata.customLayerType, undefined);
  });

  it("carries an explicit attribution into the MapLibre vector source", () => {
    const { map, calls } = makeMapStub();
    syncLayer(
      map as never,
      pluginVectorTileLayer({
        source: {
          type: "vector",
          tiles: ["https://core.example/tiles/{z}/{x}/{y}.mvt"],
          sourceLayer: "faults",
          attribution: "Core Geologix",
        },
      } as unknown as Partial<GeoLibreLayer>),
    );
    const added = calls.find((c) => c.method === "addSource");
    assert.ok(added, "addSource must be called");
    assert.equal((added!.args[1] as { attribution?: string }).attribution, "Core Geologix");
  });

  it("adds no attribution key when the layer declares none", () => {
    const { map, calls } = makeMapStub();
    syncLayer(map as never, pluginVectorTileLayer());
    const added = calls.find((c) => c.method === "addSource");
    assert.ok(added);
    assert.equal("attribution" in (added!.args[1] as object), false);
  });

  it("renders vectorRules, strokeDasharray, and zoom range through the shared style-mapper paths", () => {
    const { map, calls } = makeMapStub();
    syncLayer(
      map as never,
      pluginVectorTileLayer({
        style: {
          ...DEFAULT_LAYER_STYLE,
          minZoom: 3,
          maxZoom: 12,
          strokeDasharray: [4, 2],
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "certain",
              label: "Certain",
              filter: '["==",["get","class"],"certain"]',
              color: "#c0392b",
              isElse: false,
            },
          ],
        },
      }),
    );
    const lineLayer = calls.find(
      (c) => c.method === "addLayer" && (c.args[0] as { type?: string }).type === "line",
    );
    assert.ok(lineLayer, "a line render layer must be added");
    const spec = lineLayer!.args[0] as {
      minzoom: number;
      maxzoom: number;
      paint: Record<string, unknown>;
    };
    assert.equal(spec.minzoom, 3);
    assert.equal(spec.maxzoom, 12);
    assert.deepEqual(spec.paint["line-dasharray"], [4, 2]);
    // vectorLineColorValue turns a single rule-based vectorRule into a match
    // expression keyed on the rule's filter rather than a flat color.
    assert.ok(Array.isArray(spec.paint["line-color"]));
  });

  it("renders an attribute-driven labels symbol layer with data-driven color/opacity overrides", () => {
    const { map, calls } = makeMapStub();
    syncLayer(
      map as never,
      pluginVectorTileLayer({
        style: {
          ...DEFAULT_LAYER_STYLE,
          labels: {
            ...DEFAULT_LAYER_STYLE.labels,
            enabled: true,
            field: "name",
            colorExpression: '["get","labelColor"]',
            opacityExpression: '["get","labelOpacity"]',
          },
        },
      }),
    );
    const labelLayer = calls.find(
      (c) => c.method === "addLayer" && (c.args[0] as { type?: string }).type === "symbol",
    );
    assert.ok(labelLayer, "a labels symbol layer must be added for a vector-tiles layer");
    const spec = labelLayer!.args[0] as {
      "source-layer": string;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.equal(spec["source-layer"], "faults");
    assert.deepEqual(spec.layout["text-field"], ["to-string", ["coalesce", ["get", "name"], ""]]);
    assert.deepEqual(spec.paint["text-color"], ["get", "labelColor"]);
    assert.deepEqual(spec.paint["text-opacity"], ["get", "labelOpacity"]);
  });

  it("renders no labels layer when labels are disabled", () => {
    const { map, calls } = makeMapStub();
    syncLayer(map as never, pluginVectorTileLayer());
    const labelLayer = calls.find(
      (c) => c.method === "addLayer" && (c.args[0] as { type?: string }).type === "symbol",
    );
    assert.equal(labelLayer, undefined);
  });
});

describe("addVectorTileLayer host contract — legend", () => {
  it("produces the same rule-based legend rows a GeoJSON layer with the same style would", () => {
    const style = {
      ...DEFAULT_LAYER_STYLE,
      vectorStyleMode: "rule-based" as const,
      vectorRules: [
        {
          id: "certain",
          label: "Certain fault",
          filter: '["==",["get","class"],"certain"]',
          color: "#c0392b",
          isElse: false,
        },
      ],
    };
    const vectorTilesSwatches = legendSwatchesForLayer(
      pluginVectorTileLayer({ style }) as GeoLibreLayer,
    );
    const geojsonSwatches = legendSwatchesForLayer({
      ...pluginVectorTileLayer({ style }),
      type: "geojson",
    } as unknown as GeoLibreLayer);
    assert.deepEqual(vectorTilesSwatches, geojsonSwatches);
    assert.deepEqual(vectorTilesSwatches, [{ color: "#c0392b", label: "Certain fault" }]);
  });
});

describe("registerFeatureInteraction on a vector-tiles layer", () => {
  const LAYER_ID = "faults-layer";

  let restoreGlobals: () => void;
  let previousLayers: GeoLibreLayer[];

  beforeEach(() => {
    const { document: fakeDocument, window: fakeWindow } = parseHTML("<html><body></body></html>");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { document: fakeDocument, window: fakeWindow });
    restoreGlobals = () => {
      Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    };

    previousLayers = useAppStore.getState().layers;
    useAppStore.setState({ layers: [pluginVectorTileLayer()] });
  });

  afterEach(() => {
    restoreGlobals();
    useAppStore.setState({ layers: previousLayers });
  });

  it("finds its native style layers via vectorTileStyleLayerIds, without metadata.nativeLayerIds", () => {
    const layer = pluginVectorTileLayer();
    const ids = vectorTileStyleLayerIds(layer);
    // Mirrors the GeoJSON [fillLayerId, lineLayerId, circleLayerId] triple.
    assert.deepEqual(
      ids,
      [
        `layer-${LAYER_ID}-vector-circle`,
        `layer-${LAYER_ID}-vector-line`,
        `layer-${LAYER_ID}-vector`,
      ],
    );
    // Sanity: distinct from (and not derived from) the GeoJSON id scheme.
    assert.notEqual(ids[0], circleLayerId(LAYER_ID));
    assert.notEqual(ids[1], lineLayerId(LAYER_ID));
    assert.notEqual(ids[2], fillLayerId(LAYER_ID));
  });

  it("hovers a rendered feature on the vector-tiles layer's native line layer", () => {
    const nativeLineId = `layer-${LAYER_ID}-vector-line`;
    const canvas = { style: { cursor: "" } };
    const listeners: Record<string, Array<(event?: unknown) => void>> = {};
    let features: Array<Record<string, unknown>> = [
      { id: "f1", source: `source-${LAYER_ID}`, sourceLayer: "faults", properties: { name: "Alpine Fault" } },
    ];
    const map = {
      getLayer: (id: string) => (id === nativeLineId ? { id, type: "line" } : undefined),
      getPaintProperty: () => undefined,
      setPaintProperty: () => undefined,
      setFeatureState: () => undefined,
      removeFeatureState: () => undefined,
      queryRenderedFeatures: () => features,
      on: (event: string, handler: (event?: unknown) => void) => {
        (listeners[event] ??= []).push(handler);
      },
      off: () => undefined,
      getCanvas: () => canvas,
      getContainer: () => document.body,
    };

    const cleanup = registerFeatureInteraction(map as never, {
      layerId: LAYER_ID,
      titleField: "name",
      fields: [],
      cursor: "pointer",
    });
    listeners["mousemove"]?.forEach((handler) => handler({ point: { x: 0, y: 0 } }));
    assert.equal(canvas.style.cursor, "pointer");
    assert.ok(document.body.querySelector(".geolibre-plugin-feature-tooltip"));

    features = [];
    listeners["mousemove"]?.forEach((handler) => handler({ point: { x: 0, y: 0 } }));
    assert.equal(canvas.style.cursor, "");
    cleanup();
  });
});
