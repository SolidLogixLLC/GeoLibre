import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { useAppStore } from "../packages/core/src/store";
import { linePaint } from "../packages/map/src/style-mapper";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";
import { buildAutoLegend } from "../apps/geolibre-desktop/src/lib/auto-legend";

function faultLayer(): GeoLibreLayer {
  return {
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
        {
          id: "normal",
          label: "Normal",
          filter: '["==",["get","slip_type"],"Normal"]',
          color: "#1e88e5",
          isElse: false,
        },
      ],
    },
  } as unknown as GeoLibreLayer;
}

describe("fault cartography host contract", () => {
  it("maps upstream strokeDash and zoom-driven width expressions to MapLibre paint", () => {
    const width = ["interpolate", ["linear"], ["zoom"], 5, 1, 13, 4];
    const paint = linePaint(
      {
        ...DEFAULT_LAYER_STYLE,
        strokeDash: [4, 4],
        strokeWidthExpression: JSON.stringify(width),
      },
      1,
    ) as Record<string, unknown>;
    assert.deepEqual(paint["line-dasharray"], [4, 4]);
    assert.deepEqual(paint["line-width"], width);
    const solid = linePaint(DEFAULT_LAYER_STYLE, 1) as Record<string, unknown>;
    assert.equal(solid["line-dasharray"], undefined);
    assert.notDeepEqual(solid["line-width"], width);
  });

  it("falls back to the plain width for a malformed width expression", () => {
    const plain = linePaint(DEFAULT_LAYER_STYLE, 1) as Record<string, unknown>;
    const broken = linePaint(
      { ...DEFAULT_LAYER_STYLE, strokeWidthExpression: "not json" },
      1,
    ) as Record<string, unknown>;
    assert.deepEqual(broken["line-width"], plain["line-width"]);
  });

  it("does not reintroduce the old strokeDasharray style key", () => {
    assert.equal("strokeDasharray" in DEFAULT_LAYER_STYLE, false);
  });

  it("carries explicit GeoJSON attribution into the native source", () => {
    const previousLayers = useAppStore.getState().layers;
    try {
      useAppStore.setState({ layers: [] });
      const id = useAppStore
        .getState()
        .addGeoJsonLayer("Faults", { type: "FeatureCollection", features: [] }, undefined, null, {
          attribution: "Authoritative fault source",
        });
      const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
      assert.equal(layer?.source.attribution, "Authoritative fault source");
    } finally {
      useAppStore.setState({ layers: previousLayers });
    }
  });

  it("coalesces identical legend rules split across zoom ranges in the print legend", () => {
    assert.deepEqual(legendSwatchesForLayer(faultLayer()), [
      { color: "#e53935", label: "Reverse", panelRowIndex: 0 },
      { color: "#1e88e5", label: "Normal", panelRowIndex: 1 },
    ]);
  });

  it("lists the same coalesced rows in the on-map legend", () => {
    const [entry] = buildAutoLegend(
      [faultLayer()],
      { title: "Legend", groupByLayer: true, order: [], overrides: {} },
      { locale: "en" },
    );
    assert.deepEqual(
      entry.rows.map((row) => row.label),
      ["Reverse", "Normal"],
    );
  });
});
