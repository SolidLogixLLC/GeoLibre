import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { useAppStore } from "../packages/core/src/store";
import { linePaint } from "../packages/map/src/style-mapper";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";

describe("fault cartography host contract", () => {
  it("maps dashed strokes and zoom-driven width expressions to MapLibre paint", () => {
    const width = ["interpolate", ["linear"], ["zoom"], 5, 1, 13, 4];
    const paint = linePaint(
      {
        ...DEFAULT_LAYER_STYLE,
        strokeDasharray: [4, 4],
        strokeWidthExpression: JSON.stringify(width),
      },
      1,
    );
    assert.deepEqual(paint["line-dasharray"], [4, 4]);
    assert.deepEqual(paint["line-width"], width);
    assert.equal(linePaint(DEFAULT_LAYER_STYLE, 1)["line-dasharray"], null);
  });

  it("carries explicit GeoJSON attribution into the native source", () => {
    const previousLayers = useAppStore.getState().layers;
    try {
      useAppStore.setState({ layers: [] });
      const id = useAppStore.getState().addGeoJsonLayer("Faults", {
        type: "FeatureCollection",
        features: [],
      }, undefined, null, "Authoritative fault source");
      const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
      assert.equal(layer?.source.attribution, "Authoritative fault source");
    } finally {
      useAppStore.setState({ layers: previousLayers });
    }
  });

  it("coalesces identical legend rules split across zoom ranges", () => {
    const layer = {
      id: "gem",
      name: "GEM faults",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      metadata: {},
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "reverse-low",
            label: "Reverse",
            filter: '["all",["==",["get","slip_type"],"Reverse"],[">",["get","rate"],10]]',
            color: "#e53935",
            isElse: false,
            minZoom: 0,
            maxZoom: 6,
          },
          {
            id: "reverse-high",
            label: "Reverse",
            filter: '["==",["get","slip_type"],"Reverse"]',
            color: "#e53935",
            isElse: false,
            minZoom: 6,
            maxZoom: 24,
          },
        ],
      },
    } as unknown as GeoLibreLayer;
    assert.deepEqual(legendSwatchesForLayer(layer), [
      { color: "#e53935", label: "Reverse" },
    ]);
  });
});
