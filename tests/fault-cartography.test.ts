import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createPropertyExpression, latest as maplibreStyleSpec } from "@maplibre/maplibre-gl-style-spec";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { useAppStore } from "../packages/core/src/store";
import { linePaint } from "../packages/map/src/style-mapper";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";
import {
  hoverLineWidth,
  isHoverLineWidth,
  registerFeatureInteraction,
} from "../apps/geolibre-desktop/src/lib/feature-interaction";

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

// Regression coverage for the maplibre-gl 6 hover crash (GeoLibre fork):
// `registerFeatureInteraction`'s `line-width` wrap must be idempotent, and
// `leave()` must never revert it while a `removeFeatureState` is pending —
// only `cleanup()` reverts, and without touching feature state. See
// control/briefs/fix-hover-width-maplibre6.md.
describe("registerFeatureInteraction hover width (maplibre-gl 6)", () => {
  const NATIVE_LINE_ID = "fault-line-native";
  const LAYER_ID = "fault-layer";
  const lineWidthSpec = maplibreStyleSpec.paint_line["line-width"];

  function assertValidLineWidth(value: unknown) {
    const result = createPropertyExpression(
      value as never,
      "paint_line.line-width",
      lineWidthSpec as never,
    );
    assert.equal(
      result.result,
      "success",
      result.result === "error" ? JSON.stringify(result.value) : undefined,
    );
  }

  interface RecordedCall {
    method: string;
    args: unknown[];
  }

  function makeFakeMap(initialLineWidth: unknown) {
    const paint: Record<string, unknown> = { "line-width": initialLineWidth };
    const calls: RecordedCall[] = [];
    const listeners: Record<string, Array<(event?: unknown) => void>> = {};
    const canvas = { style: { cursor: "" } };
    let features: Array<Record<string, unknown>> = [];

    const map = {
      getLayer: (id: string) => (id === NATIVE_LINE_ID ? { id, type: "line" } : undefined),
      getPaintProperty: (id: string, prop: string) => {
        calls.push({ method: "getPaintProperty", args: [id, prop] });
        return paint[prop];
      },
      setPaintProperty: (id: string, prop: string, value: unknown) => {
        calls.push({ method: "setPaintProperty", args: [id, prop, value] });
        paint[prop] = value;
      },
      setFeatureState: (target: unknown, state: unknown) => {
        calls.push({ method: "setFeatureState", args: [target, state] });
      },
      removeFeatureState: (target: unknown, key: unknown) => {
        calls.push({ method: "removeFeatureState", args: [target, key] });
      },
      queryRenderedFeatures: () => features,
      on: (event: string, handler: (event?: unknown) => void) => {
        (listeners[event] ??= []).push(handler);
      },
      off: (event: string, handler: (event?: unknown) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((existing) => existing !== handler);
      },
      getCanvas: () => canvas,
      getContainer: () => document.body,
    };

    return {
      map,
      calls,
      paint,
      setFeature: (feature: Record<string, unknown> | null) => {
        features = feature ? [feature] : [];
      },
      fireMouseMove: (event: unknown = { point: { x: 0, y: 0 } }) =>
        listeners["mousemove"]?.slice().forEach((handler) => handler(event)),
      fireMouseOut: (event: unknown = {}) => listeners["mouseout"]?.slice().forEach((handler) => handler(event)),
    };
  }

  let restoreGlobals: () => void;
  let previousLayers: GeoLibreLayer[];

  beforeEach(() => {
    // featureTooltip() builds real DOM nodes; run against linkedom rather than
    // stubbing document.createElement, mirroring tests/panel-dom.test.ts.
    const { document: fakeDocument, window: fakeWindow } = parseHTML("<html><body></body></html>");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { document: fakeDocument, window: fakeWindow });
    restoreGlobals = () => {
      Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    };

    previousLayers = useAppStore.getState().layers;
    useAppStore.setState({
      layers: [
        {
          id: LAYER_ID,
          name: "QFaults",
          type: "geojson",
          source: {},
          visible: true,
          opacity: 1,
          metadata: { nativeLayerIds: [NATIVE_LINE_ID] },
          style: { ...DEFAULT_LAYER_STYLE },
        } as unknown as GeoLibreLayer,
      ],
    });
  });

  afterEach(() => {
    restoreGlobals();
    useAppStore.setState({ layers: previousLayers });
  });

  const feature = (id: string) => ({
    id,
    source: "fault-source",
    properties: {},
  });

  it("wraps line-width exactly once and never reverts it on leave", () => {
    const fake = makeFakeMap(["interpolate", ["linear"], ["zoom"], 5, 1, 13, 4]);
    fake.setFeature(feature("A"));
    const cleanup = registerFeatureInteraction(fake.map as never, {
      layerId: LAYER_ID,
      fields: [],
      hoverStrokeWidthDelta: 2,
    });

    fake.fireMouseMove(); // enter
    fake.fireMouseOut(); // leave
    fake.fireMouseMove(); // enter again
    fake.fireMouseOut(); // leave again

    const widthWrites = fake.calls.filter(
      (call) => call.method === "setPaintProperty" && call.args[1] === "line-width",
    );
    assert.equal(widthWrites.length, 1, "line-width must be set exactly once (the wrap)");
    assert.ok(isHoverLineWidth(fake.paint["line-width"]), "the wrap must survive every leave");

    cleanup();
  });

  it("wraps once when two registrations share the same native layer (no nested case)", () => {
    const fake = makeFakeMap(3);
    fake.setFeature(feature("A"));
    const cleanupA = registerFeatureInteraction(fake.map as never, {
      layerId: LAYER_ID,
      fields: [],
      hoverStrokeWidthDelta: 2,
    });
    const cleanupB = registerFeatureInteraction(fake.map as never, {
      layerId: LAYER_ID,
      fields: [],
      hoverStrokeWidthDelta: 2,
    });

    fake.fireMouseMove(); // both registrations see this event

    const widthWrites = fake.calls.filter(
      (call) => call.method === "setPaintProperty" && call.args[1] === "line-width",
    );
    assert.equal(widthWrites.length, 1, "only the first registration may wrap");
    const occurrences = JSON.stringify(fake.paint["line-width"]).split('"geolibre-plugin-hover"').length - 1;
    assert.equal(occurrences, 1, "the hover case must not nest");

    cleanupA();
    cleanupB();
  });

  it("cleanup restores the original width without touching feature state", () => {
    const original = 3;
    const fake = makeFakeMap(original);
    fake.setFeature(feature("A"));
    const cleanup = registerFeatureInteraction(fake.map as never, {
      layerId: LAYER_ID,
      fields: [],
      hoverStrokeWidthDelta: 2,
    });

    fake.fireMouseMove(); // enter: wraps, sets feature state
    const callsBeforeCleanup = fake.calls.length;
    cleanup();

    assert.equal(fake.paint["line-width"], original);
    const callsDuringCleanup = fake.calls.slice(callsBeforeCleanup);
    assert.ok(
      callsDuringCleanup.some(
        (call) => call.method === "setPaintProperty" && call.args[2] === original,
      ),
      "cleanup must restore the original width",
    );
    assert.ok(
      !callsDuringCleanup.some((call) => call.method === "removeFeatureState"),
      "cleanup must not touch feature state",
    );
  });

  it("produces a valid maplibre-gl 6 line-width expression for every input shape", () => {
    assertValidLineWidth(hoverLineWidth(undefined, 2));
    assertValidLineWidth(hoverLineWidth(3, 2));
    assertValidLineWidth(hoverLineWidth({ stops: [[5, 1], [13, 4]] }, 2));
    assertValidLineWidth(hoverLineWidth(["interpolate", ["linear"], ["zoom"], 5, 1, 13, 4], 2));
  });
});
