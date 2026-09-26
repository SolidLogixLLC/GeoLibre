import type { GeoLibreLayer } from "@geolibre/core";

/**
 * A vector-tile source layer's name inside a MapLibre layer id. Not injective: `a/b` and `a_2Fb`
 * both encode to `a_2Fb`, a collision inherited from `layer-sync` rather than introduced here.
 */
export function encodeVectorTileLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

/**
 * The `"vector-tiles"` source-layer names a store layer renders: `source.sourceLayers` when the
 * layer carries several (e.g. a multi-layer OGC Vector Tiles source), otherwise the single
 * `source.sourceLayer` a plugin's `addVectorTileLayer` sets. Pure (no MapLibre import) so it can be
 * shared by `layer-sync` (rendering) and `feature-interaction` (hover/click) without either pulling
 * in the other's dependencies.
 */
export function getVectorTileSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  if (Array.isArray(sourceLayers)) {
    return sourceLayers.filter(
      (sourceLayer): sourceLayer is string =>
        typeof sourceLayer === "string" && sourceLayer.length > 0,
    );
  }

  const sourceLayer = layer.source.sourceLayer;
  return typeof sourceLayer === "string" && sourceLayer.length > 0 ? [sourceLayer] : [];
}

/**
 * Only include the source-layer name in a derived id when the layer actually renders more than
 * one: a single-source-layer layer (the common `addVectorTileLayer` case) keeps the shorter,
 * unscoped id it has always had.
 */
export function vectorTileScopedSourceLayer(
  layer: GeoLibreLayer,
  sourceLayer: string,
): string | undefined {
  return getVectorTileSourceLayers(layer).length > 1 ? sourceLayer : undefined;
}

export function vectorTileLayerId(
  layerId: string,
  extrusionEnabled = false,
  sourceLayer?: string,
): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-${extrusionEnabled ? "extrusion" : "fill"}`;
  }
  return `layer-${layerId}-${extrusionEnabled ? "vector-extrusion" : "vector"}`;
}

export function vectorTileLineLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-line`;
  }
  return `layer-${layerId}-vector-line`;
}

export function vectorTileCircleLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-circle`;
  }
  return `layer-${layerId}-vector-circle`;
}

/**
 * Id of the attribute-driven labels symbol layer `syncVectorTileLayer` renders for one source
 * layer (see `labels` in `LayerStyle`). Mirrors {@link vectorTileLineLayerId}'s scoping so it
 * falls under the same `layer-<id>-vector` stale-cleanup prefix.
 */
export function vectorTileLabelLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-label`;
  }
  return `layer-${layerId}-vector-label`;
}

/**
 * The fill/line/circle (or fill-extrusion) style layer ids a `"vector-tiles"` layer currently
 * renders through, one set per source layer. Used by `registerFeatureInteraction` to find the
 * layer's hoverable/clickable native layers, mirroring the GeoJSON `[fillLayerId, lineLayerId,
 * circleLayerId]` triple -- deliberately excludes the labels symbol layer, just as the GeoJSON path
 * excludes its own text layer from hover targets.
 */
export function vectorTileStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "vector-tiles") return [];
  return getVectorTileSourceLayers(layer).flatMap((sourceLayer) => {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    if (layer.style.extrusionEnabled) {
      return [vectorTileLayerId(layer.id, true, layerPart)];
    }
    return [
      vectorTileCircleLayerId(layer.id, layerPart),
      vectorTileLineLayerId(layer.id, layerPart),
      vectorTileLayerId(layer.id, false, layerPart),
    ];
  });
}
