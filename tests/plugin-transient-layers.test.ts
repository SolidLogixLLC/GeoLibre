import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseProject, projectFromStore, serializeProject, useAppStore } from "@geolibre/core";
import { createAppAPI, type AppApiHost } from "../apps/geolibre-desktop/src/lib/app-api";

// Fork feature: `addGeoJsonLayer(..., { transient: true })` keeps the features
// out of saved projects; the plugin refills them with upstream's
// `updateGeoJsonLayer` after the project is reopened.

const host = {
  plugins: {},
  getGeometryEditTargetLayerId: () => null,
} as unknown as AppApiHost;

const features = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [1, 2] },
    },
  ],
};

function saved() {
  const state = useAppStore.getState();
  return parseProject(serializeProject(projectFromStore(state)));
}

describe("transient plugin GeoJSON layers", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Transient" });
  });

  it("keeps a transient layer's features out of the saved project but keeps the layer", () => {
    const api = createAppAPI(undefined, host);
    const id = api.addGeoJsonLayer("Live", features, undefined, { transient: true });
    assert.equal(api.getLayerFeatureCount(id), 1);
    const [layer] = saved().layers;
    assert.equal(layer.name, "Live");
    assert.equal(layer.geojson, undefined);
  });

  it("saves a layer added without the option as before", () => {
    const api = createAppAPI(undefined, host);
    api.addGeoJsonLayer("Plain", features);
    assert.equal(saved().layers[0].geojson?.features.length, 1);
  });

  it("refills a reopened transient layer through updateGeoJsonLayer", () => {
    const api = createAppAPI(undefined, host);
    api.addGeoJsonLayer("Live", features, undefined, { transient: true });
    const project = saved();
    useAppStore.getState().loadProject(project);
    const reopened = useAppStore.getState().layers[0];
    assert.equal(api.getLayerFeatureCount(reopened.id), 0);
    assert.equal(api.updateGeoJsonLayer(reopened.id, features), true);
    assert.equal(api.getLayerFeatureCount(reopened.id), 1);
  });

  it("getLayerFeatureCount throws for an unknown layer", () => {
    const api = createAppAPI(undefined, host);
    assert.throws(() => api.getLayerFeatureCount("missing"), /No layer with id/);
  });
});
