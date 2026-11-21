import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROJECT_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { normalizeSharedDesktopSettings } from "../apps/geolibre-desktop/src/lib/desktop-settings-url";

describe("project settings", () => {
  it("defaults the plugin publishable-state setting when absent", () => {
    assert.deepEqual(normalizeDesktopSettings({}).projects, DEFAULT_PROJECT_SETTINGS);
    assert.deepEqual(normalizeDesktopSettings({ projects: null }).projects, DEFAULT_PROJECT_SETTINGS);
  });

  it("keeps an explicit boolean either way", () => {
    for (const value of [true, false]) {
      const projects = normalizeDesktopSettings({
        projects: { pluginPublishableState: value },
      }).projects;
      assert.equal(projects.pluginPublishableState, value);
    }
  });

  it("ignores a non-boolean value", () => {
    const projects = normalizeDesktopSettings({
      projects: { pluginPublishableState: "yes" },
    }).projects;
    assert.equal(
      projects.pluginPublishableState,
      DEFAULT_PROJECT_SETTINGS.pluginPublishableState,
    );
  });

  it("does not let a shared settings link change it", () => {
    const flipped = !DEFAULT_PROJECT_SETTINGS.pluginPublishableState;
    const shared = normalizeSharedDesktopSettings({
      projects: { pluginPublishableState: flipped },
    });
    assert.equal(
      shared.projects.pluginPublishableState,
      DEFAULT_PROJECT_SETTINGS.pluginPublishableState,
    );
  });
});
