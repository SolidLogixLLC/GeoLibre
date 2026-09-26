import { useAppStore } from "@geolibre/core";
import {
  circleLayerId,
  fillLayerId,
  lineLayerId,
  vectorTileStyleLayerIds,
} from "@geolibre/map/style-layer-ids";
import type { GeoLibreFeatureInteractionOptions } from "@geolibre/plugins";
import type {
  DataDrivenPropertyValueSpecification,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";

/**
 * `registerFeatureInteraction`, `hoverLineWidth`, `isHoverLineWidth` and
 * `featureTooltip`, split out of `usePlugins.ts` (no behaviour change).
 *
 * Kept out of `usePlugins.ts` on purpose. That module imports the whole
 * built-in plugin registry (and through it MapCanvas, CesiumCanvas, and every
 * `maplibre-*` plugin), so a unit test reaching this code had to stub
 * `maplibre-gl`, `window`, and `localStorage` just to load the module, and
 * dragged dozens of browser-only files into the coverage report along the
 * way. This code needs only the map instance and the store, so it lives here
 * and `usePlugins.ts` imports it. Same reasoning as `plugin-layer-queries.ts`.
 */

// The `line-width` paint property's spec default (maplibre-gl-style-spec
// paint_line["line-width"].default). Used whenever a paint value must be
// treated as a number but isn't one — see the `undefined` branch below.
const LINE_WIDTH_SPEC_DEFAULT = 1;

/**
 * Wraps a `line-width` paint value so it widens by `delta` while
 * `geolibre-plugin-hover` feature state is set, and falls back to the
 * original value otherwise.
 *
 * `map.getPaintProperty` can hand back several shapes for a plugin-authored
 * width: a plain number, a legacy `{ stops, base? }` zoom function, a
 * top-level `interpolate`/`step` on `["zoom"]`, another data-driven
 * expression, or `undefined` (the property was never explicitly set, so it
 * is at the paint spec's default). Every branch here must produce an
 * expression maplibre-gl 6 accepts: the feature-state `case` has to stay
 * nested *inside* each zoom-curve output, because `["zoom"]` itself is only
 * legal as the direct input of a top-level `interpolate`/`step` — and no
 * branch may embed a bare `undefined` or a non-expression object as an
 * operand, which maplibre-gl 6 rejects outright (silently, via its style
 * validator) rather than resolving to a number.
 */
export function isHoverLineWidth(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('"geolibre-plugin-hover"');
}

export function hoverLineWidth(value: unknown, delta: number): unknown {
  const whenHovered = (entry: unknown) => [
    "case",
    ["boolean", ["feature-state", "geolibre-plugin-hover"], false],
    typeof entry === "number" ? entry + delta : ["+", entry, delta],
    entry,
  ];
  if (
    Array.isArray(value) &&
    (value[0] === "interpolate" || value[0] === "step")
  ) {
    return value.map((entry, index) =>
      value[0] === "interpolate"
        ? index >= 4 && index % 2 === 0
          ? whenHovered(entry)
          : entry
        : index === 2 || (index >= 4 && index % 2 === 0)
          ? whenHovered(entry)
          : entry,
    );
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { stops?: unknown }).stops)
  ) {
    // A legacy zoom function is a plain object, not an expression array —
    // embedding it as an operand (e.g. inside `["+", value, delta]`) is not
    // a valid expression node. Convert it to the equivalent `interpolate`
    // first, then recurse so the feature-state `case` nests inside its
    // outputs like it does for an authored `interpolate`.
    const legacy = value as { stops: [number, number][]; base?: number };
    const interpolation = legacy.base && legacy.base !== 1 ? ["exponential", legacy.base] : ["linear"];
    const converted: unknown[] = ["interpolate", interpolation, ["zoom"]];
    for (const [stopZoom, stopValue] of legacy.stops) converted.push(stopZoom, stopValue);
    return hoverLineWidth(converted, delta);
  }
  if (typeof value !== "number" && !Array.isArray(value)) {
    // `undefined` (never explicitly set) or any other non-expression,
    // non-numeric shape: fall back to the spec default instead of wrapping
    // it directly, which would embed an invalid literal operand.
    return whenHovered(LINE_WIDTH_SPEC_DEFAULT);
  }
  return whenHovered(value);
}

function featureTooltip(
  options: GeoLibreFeatureInteractionOptions,
  properties: Record<string, unknown>,
): HTMLDivElement {
  const tooltip = document.createElement("div");
  tooltip.className = "geolibre-plugin-feature-tooltip";
  Object.assign(tooltip.style, {
    position: "absolute",
    zIndex: "20",
    pointerEvents: "none",
    minWidth: "180px",
    maxWidth: "320px",
    padding: "8px 10px",
    borderRadius: "6px",
    background: "rgba(17, 24, 39, 0.94)",
    color: "#ffffff",
    font: "12px/1.4 system-ui, sans-serif",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.28)",
  });
  if (options.titleField) {
    const title = document.createElement("strong");
    title.style.display = "block";
    title.style.marginBottom = "4px";
    title.textContent = String(properties[options.titleField] ?? "Unnamed feature");
    tooltip.append(title);
  }
  for (const field of options.fields) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.style.opacity = "0.72";
    label.textContent = `${field.label}: `;
    const value = document.createElement("span");
    const raw = properties[field.field];
    value.textContent =
      raw === null || raw === undefined || raw === "" ? "Not published" : String(raw);
    row.append(label, value);
    tooltip.append(row);
  }
  return tooltip;
}

export function registerFeatureInteraction(
  map: MapLibreMap | null,
  options: GeoLibreFeatureInteractionOptions,
): () => void {
  if (!map) return () => undefined;
  let tooltip: HTMLDivElement | null = null;
  let hovering = false;
  let hoveredFeatureState:
    | { source: string; sourceLayer?: string; id: string | number }
    | null = null;
  const originalLineWidths = new Map<string, unknown>();
  const originalFillOpacities = new Map<string, unknown>();

  const nativeLayerIds = () => {
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === options.layerId);
    const ids = layer?.metadata.nativeLayerIds;
    if (Array.isArray(ids)) {
      return ids.filter(
        (id): id is string => typeof id === "string" && Boolean(map.getLayer(id)),
      );
    }
    if (layer?.type === "geojson") {
      return [fillLayerId(layer.id), lineLayerId(layer.id), circleLayerId(layer.id)].filter(
        (id) => Boolean(map.getLayer(id)),
      );
    }
    if (layer?.type === "vector-tiles") {
      return vectorTileStyleLayerIds(layer).filter((id) => Boolean(map.getLayer(id)));
    }
    return [];
  };

  // Hover never flips `line-width` back and forth. maplibre-gl 6 applies a
  // queued feature-state change against the layer's *current* paint value,
  // so reverting to a non-data-driven width while a removeFeatureState is
  // pending throws "this.expression.evaluate is not a function" inside
  // updatePaintArrays. The width is wrapped once (idempotently) and hover
  // only toggles feature state; the original width returns at cleanup.
  const clearHoveredFeature = () => {
    if (hoveredFeatureState) {
      map.removeFeatureState(hoveredFeatureState, "geolibre-plugin-hover");
      hoveredFeatureState = null;
    }
  };

  const restoreFillOpacities = () => {
    for (const [id, value] of originalFillOpacities) {
      if (map.getLayer(id)) {
        map.setPaintProperty(
          id,
          "fill-opacity",
          value as DataDrivenPropertyValueSpecification<number> | undefined,
        );
      }
    }
    originalFillOpacities.clear();
  };

  // Only at cleanup, and without touching feature state (see above).
  const restoreLineWidths = () => {
    for (const [id, value] of originalLineWidths) {
      if (map.getLayer(id) && isHoverLineWidth(map.getPaintProperty(id, "line-width"))) {
        map.setPaintProperty(
          id,
          "line-width",
          value as DataDrivenPropertyValueSpecification<number> | undefined,
        );
      }
    }
    originalLineWidths.clear();
  };

  const hideTooltip = () => {
    tooltip?.remove();
    tooltip = null;
    map.getCanvas().style.cursor = "";
  };

  const leave = () => {
    if (!hovering) return;
    hovering = false;
    clearHoveredFeature();
    restoreFillOpacities();
    hideTooltip();
  };

  const move = (event: MapMouseEvent) => {
    const ids = nativeLayerIds();
    if (ids.length === 0) {
      leave();
      return;
    }
    const feature = map.queryRenderedFeatures(event.point, { layers: ids })[0];
    if (!feature) {
      leave();
      return;
    }
    if (!hovering) {
      hovering = true;
      if (options.cursor === "pointer") map.getCanvas().style.cursor = "pointer";
      const strokeDelta = Math.max(0, options.hoverStrokeWidthDelta ?? 0);
      for (const id of ids) {
        const styleLayer = map.getLayer(id);
        if (styleLayer?.type === "line" && strokeDelta > 0) {
          const current = map.getPaintProperty(id, "line-width");
          // Already wrapped by this or another registration on the same
          // native layer: wrapping again would nest the hover case.
          if (isHoverLineWidth(current)) continue;
          originalLineWidths.set(id, current);
          map.setPaintProperty(
            id,
            "line-width",
            hoverLineWidth(current, strokeDelta) as
              | DataDrivenPropertyValueSpecification<number>
              | undefined,
          );
        }
        if (styleLayer?.type === "fill" && options.hoverFillOpacity !== undefined) {
          originalFillOpacities.set(id, map.getPaintProperty(id, "fill-opacity"));
          map.setPaintProperty(id, "fill-opacity", options.hoverFillOpacity);
        }
      }
    }
    if (feature.id !== undefined) {
      const nextFeatureState = {
        source: feature.source,
        ...(feature.sourceLayer ? { sourceLayer: feature.sourceLayer } : {}),
        id: feature.id,
      };
      const changed =
        hoveredFeatureState?.source !== nextFeatureState.source ||
        hoveredFeatureState?.sourceLayer !== nextFeatureState.sourceLayer ||
        hoveredFeatureState?.id !== nextFeatureState.id;
      if (changed) {
        if (hoveredFeatureState) {
          map.removeFeatureState(hoveredFeatureState, "geolibre-plugin-hover");
        }
        hoveredFeatureState = nextFeatureState;
        map.setFeatureState(nextFeatureState, { "geolibre-plugin-hover": true });
      }
    }
    tooltip?.remove();
    tooltip = featureTooltip(options, feature.properties ?? {});
    tooltip.style.transform = `translate(${event.point.x + 12}px, ${event.point.y + 12}px)`;
    map.getContainer().append(tooltip);
  };

  let disposed = false;
  let unsubscribeLayerRemoval: () => void = () => undefined;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeLayerRemoval();
    map.off("mousemove", move);
    map.off("mouseout", leave);
    restoreLineWidths();
    hovering = false;
    restoreFillOpacities();
    hideTooltip();
  };
  unsubscribeLayerRemoval = useAppStore.subscribe((state, previous) => {
    const existed = previous.layers.some((layer) => layer.id === options.layerId);
    const exists = state.layers.some((layer) => layer.id === options.layerId);
    if (existed && !exists) cleanup();
  });
  map.on("mousemove", move);
  map.on("mouseout", leave);
  return cleanup;
}
