import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  parseProject,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import {
  pmtilesNativeLayerIds,
  removeLayerFromMap,
  syncLayer,
} from "../packages/map/src/layer-sync";

interface MapCall {
  method: string;
  args: unknown[];
}

function makeMapStub() {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => undefined,
    addLayer: record("addLayer"),
    addSource: record("addSource"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    setFilter: record("setFilter"),
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    once: record("once"),
  };
  return { map, calls };
}

describe("store.addPmtilesLayer", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "PMTiles" });
    useAppStore.temporal.getState().clear();
  });

  it("adds a persistent vector archive with deterministic native ids", () => {
    const id = useAppStore.getState().addPmtilesLayer("Faults", {
      url: " https://data.example/faults.pmtiles ",
      sourceLayer: "fault traces",
      attribution: " © Example ",
      visible: false,
      opacity: 0.6,
      minzoom: 5,
      maxzoom: 14,
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
    assert.ok(layer);
    assert.equal(layer.type, "pmtiles");
    assert.equal(layer.source.url, "https://data.example/faults.pmtiles");
    assert.equal(layer.source.attribution, "© Example");
    assert.equal(layer.source.sourceId, id);
    assert.deepEqual(layer.source.sourceLayers, ["fault traces"]);
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.6);
    assert.equal(layer.style.minZoom, 5);
    assert.equal(layer.style.maxZoom, 14);
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.sourceKind, "pmtiles-url");
    assert.deepEqual(
      layer.metadata.nativeLayerIds,
      pmtilesNativeLayerIds(id, "vector", ["fault traces"]),
    );

    const reopened = parseProject(
      serializeProject({
        ...createEmptyProject("PMTiles"),
        layers: useAppStore.getState().layers,
      }),
    );
    const restored = reopened.layers.find((candidate) => candidate.id === id);
    assert.equal(restored?.source.url, "https://data.example/faults.pmtiles");
    assert.deepEqual(restored?.source.sourceLayers, ["fault traces"]);
  });

  it("honors deterministic before-layer ordering", () => {
    const top = useAppStore.getState().addPmtilesLayer("Top", {
      url: "https://data.example/top.pmtiles",
      sourceLayer: "top",
    });
    const bottom = useAppStore.getState().addPmtilesLayer(
      "Bottom",
      {
        url: "https://data.example/bottom.pmtiles",
        sourceLayer: "bottom",
      },
      top,
    );
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      [bottom, top],
    );
  });

  it("validates URLs, source layers, and zoom ranges", () => {
    assert.throws(
      () =>
        useAppStore.getState().addPmtilesLayer("Empty", {
          url: " ",
          sourceLayer: "faults",
        }),
      /url must be a non-empty string/,
    );
    assert.throws(
      () =>
        useAppStore.getState().addPmtilesLayer("Empty", {
          url: "https://data.example/f.pmtiles",
          sourceLayer: " ",
        }),
      /sourceLayer must be a non-empty string/,
    );
    assert.throws(
      () =>
        useAppStore.getState().addPmtilesLayer("Inverted", {
          url: "https://data.example/f.pmtiles",
          sourceLayer: "faults",
          minzoom: 14,
          maxzoom: 5,
        }),
      /minzoom \(14\) must be <= maxzoom \(5\)/,
    );
    assert.throws(
      () =>
        useAppStore.getState().addPmtilesLayer("Invalid", {
          url: "https://data.example/f.pmtiles",
          sourceLayer: "faults",
          minzoom: Number.NaN,
        }),
      /finite values from 0 through 24/,
    );
    assert.throws(
      () =>
        useAppStore.getState().addPmtilesLayer("Out of range", {
          url: "https://data.example/f.pmtiles",
          sourceLayer: "faults",
          maxzoom: 25,
        }),
      /finite values from 0 through 24/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});

describe("PMTiles vector synchronization", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "PMTiles sync" });
    useAppStore.temporal.getState().clear();
  });

  it("forwards attribution and line-following expression labels", () => {
    const id = useAppStore.getState().addPmtilesLayer("Faults", {
      url: "https://data.example/faults.pmtiles",
      sourceLayer: "faults",
      attribution: "© Fault authority",
    });
    useAppStore.getState().setLayerStyle(id, {
      strokeDasharray: [4, 4],
      strokeWidthExpression: '["interpolate",["linear"],["zoom"],5,1,13,4]',
      labels: {
        enabled: true,
        field: "name",
        placement: "line",
        minZoom: 11,
        size: 12,
        haloWidth: 2,
        colorExpression: '["match",["get","age_class"],"Holocene","#e53935","#9e9e9e"]',
      },
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
    assert.ok(layer);
    const { map, calls } = makeMapStub();

    syncLayer(map as never, layer);

    const source = calls.find((call) => call.method === "addSource");
    assert.ok(source);
    assert.deepEqual(source.args[1], {
      type: "vector",
      url: "pmtiles://https://data.example/faults.pmtiles",
      attribution: "© Fault authority",
    });
    const specs = calls
      .filter((call) => call.method === "addLayer")
      .map((call) => call.args[0] as Record<string, unknown>);
    const label = specs.find((spec) => spec.type === "symbol");
    assert.ok(label);
    assert.equal(label["source-layer"], "faults");
    assert.equal(label.minzoom, 11);
    const layout = label.layout as Record<string, unknown>;
    assert.equal(layout["symbol-placement"], "line");
    assert.deepEqual(layout["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
    const paint = label.paint as Record<string, unknown>;
    assert.deepEqual(paint["text-color"], [
      "match",
      ["get", "age_class"],
      "Holocene",
      "#e53935",
      "#9e9e9e",
    ]);
    assert.equal(paint["text-halo-width"], 2);
  });

  it("removes geometry, label, and source state together", () => {
    const id = useAppStore.getState().addPmtilesLayer("Faults", {
      url: "https://data.example/faults.pmtiles",
      sourceLayer: "faults",
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
    assert.ok(layer);
    const nativeIds = pmtilesNativeLayerIds(id, "vector", ["faults"]);
    const labelId = `${id}-faults-label`;
    const calls: MapCall[] = [];
    const map = {
      getLayer: (candidate: string) =>
        nativeIds.includes(candidate) || candidate === labelId ? { id: candidate } : undefined,
      getSource: (candidate: string) => (candidate === id ? { id: candidate } : undefined),
      removeLayer: (candidate: string) =>
        calls.push({ method: "removeLayer", args: [candidate] }),
      removeSource: (candidate: string) =>
        calls.push({ method: "removeSource", args: [candidate] }),
    };

    removeLayerFromMap(map as never, id, layer);

    assert.deepEqual(
      calls
        .filter((call) => call.method === "removeLayer")
        .map((call) => call.args[0]),
      [...nativeIds, labelId],
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "removeSource")
        .map((call) => call.args[0]),
      [id],
    );
  });
});
