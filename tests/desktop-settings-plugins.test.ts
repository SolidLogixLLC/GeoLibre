import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

describe("DesktopSettings plugin manifest URLs", () => {
  it("uses the local development manifest when the setting is absent", () => {
    assert.deepEqual(normalizeDesktopSettings({}).pluginManifestUrls, [
      "http://localhost:3000/plugin.json",
    ]);
  });

  it("preserves an explicitly empty manifest list", () => {
    assert.deepEqual(
      normalizeDesktopSettings({ pluginManifestUrls: [] }).pluginManifestUrls,
      [],
    );
  });

  it("normalizes explicit manifests without restoring the default", () => {
    assert.deepEqual(
      normalizeDesktopSettings({
        pluginManifestUrls: [
          " https://example.com/plugin.json ",
          "javascript:alert(1)",
        ],
      }).pluginManifestUrls,
      ["https://example.com/plugin.json"],
    );
  });
});
