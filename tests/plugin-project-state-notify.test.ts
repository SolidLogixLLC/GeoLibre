import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { ProjectPluginState } from "@geolibre/core";
import { projectAutosaveChanged } from "../apps/geolibre-desktop/src/lib/project-autosave-changed";
import {
  createProjectStateNotifier,
  PROJECT_STATE_NOTIFY_DELAY_MS,
} from "../apps/geolibre-desktop/src/lib/plugin-project-state-notifier";
import {
  DEFAULT_PROJECT_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

/**
 * Coverage for control/briefs/plugin-notify-project-state.md: a plugin's
 * `app.notifyProjectStateChanged()` refreshes `projectPlugins`, marks the
 * project dirty, and the autosave predicate picks the change up. The desktop
 * wiring in `usePlugins.ts` is a thin shell over `createProjectStateNotifier`
 * plus the manager (importing that hook pulls in the whole plugin registry), so
 * it is exercised here with a real PluginManager and the real store.
 */

type FakeTimer = { id: number; callback: () => void };

function makeRig(options: { enabled?: boolean } = {}) {
  const manager = new PluginManager();
  const app = {} as GeoLibreAppAPI;
  let counter = 0;
  const plugin: GeoLibrePlugin = {
    id: "sites",
    name: "Sites",
    version: "0.1.0",
    activate: () => undefined,
    deactivate: () => undefined,
    getProjectState: () => ({ counter }),
    applyProjectState: (_app, state) => {
      counter = (state as { counter: number }).counter;
    },
  };
  manager.register(plugin);

  const timers: FakeTimer[] = [];
  let nextId = 1;
  const state = { enabled: options.enabled ?? true };
  const snapshot = (): ProjectPluginState => ({
    ...manager.getProjectState(),
    manifestUrls: useAppStore.getState().projectPlugins?.manifestUrls ?? [],
  });
  const notifier = createProjectStateNotifier({
    isEnabled: () => state.enabled,
    isRestoring: () => manager.isRestoring(),
    generation: () => useAppStore.getState().projectGeneration,
    snapshot,
    stored: () => useAppStore.getState().projectPlugins,
    commit: (next) => useAppStore.getState().setProjectPlugins(next),
    schedule: (callback) => {
      const timer = { id: nextId++, callback };
      timers.push(timer);
      return timer.id;
    },
    cancel: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    manager,
    app,
    plugin,
    notifier,
    state,
    timers,
    setCounter: (value: number) => {
      counter = value;
    },
    snapshot,
    fire: () => {
      const due = timers.splice(0);
      for (const timer of due) timer.callback();
    },
  };
}

beforeEach(() => {
  useAppStore.setState({ projectPlugins: null, isDirty: false });
});

describe("notifyProjectStateChanged", () => {
  it("marks the project dirty and stores the changed plugin state", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    assert.equal(useAppStore.getState().isDirty, false);

    rig.setCounter(3);
    rig.notifier.notify();
    assert.equal(useAppStore.getState().isDirty, false, "the refresh waits for the window");
    rig.fire();

    assert.equal(useAppStore.getState().isDirty, true);
    assert.deepEqual(useAppStore.getState().projectPlugins?.settings.sites, { counter: 3 });
  });

  it("does not dirty the project when the serialized state is unchanged", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    const before = useAppStore.getState().projectPlugins;

    rig.notifier.notify();
    rig.fire();

    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.getState().projectPlugins, before);
  });

  it("is ignored while a project restore is running", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    let sawRestoring = false;
    rig.plugin.applyProjectState = (_app, state) => {
      rig.setCounter((state as { counter: number }).counter);
      sawRestoring = rig.manager.isRestoring();
      // A plugin applying its loaded state often announces it; the host must
      // not treat that as the user editing the project.
      rig.notifier.notify();
    };
    rig.manager.register(rig.plugin);

    rig.manager.restoreProjectState(
      {
        activePluginIds: [],
        mapControlPositions: {},
        settings: { sites: { counter: 9 } },
        manifestUrls: [],
      },
      rig.app,
    );

    assert.equal(sawRestoring, true);
    assert.equal(rig.manager.isRestoring(), false, "the flag clears once the restore ends");
    assert.equal(rig.timers.length, 0, "nothing was scheduled");
    rig.fire();
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("clears the restoring flag when a restore throws", () => {
    const rig = makeRig();
    rig.plugin.applyProjectState = () => {
      throw new Error("bad state");
    };
    rig.manager.register(rig.plugin);
    assert.throws(() =>
      rig.manager.restoreProjectState(
        {
          activePluginIds: [],
          mapControlPositions: {},
          settings: { sites: {} },
          manifestUrls: [],
        },
        rig.app,
      ),
    );
    assert.equal(rig.manager.isRestoring(), false);
  });

  it("does nothing while the setting is off", () => {
    const rig = makeRig({ enabled: false });
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    rig.setCounter(5);

    rig.notifier.notify();
    rig.fire();

    assert.equal(rig.timers.length, 0);
    assert.equal(useAppStore.getState().isDirty, false);
    assert.deepEqual(useAppStore.getState().projectPlugins?.settings.sites, { counter: 0 });
  });

  it("drops a refresh that was waiting when the setting is turned off", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    rig.setCounter(5);
    rig.notifier.notify();
    rig.state.enabled = false;
    rig.fire();
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("coalesces a burst of calls into one refresh", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    let commits = 0;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.projectPlugins !== previous.projectPlugins) commits += 1;
    });
    try {
      for (let value = 1; value <= 20; value += 1) {
        rig.setCounter(value);
        rig.notifier.notify();
      }
      assert.equal(rig.timers.length, 1);
      rig.fire();
      assert.equal(commits, 1);
      assert.deepEqual(useAppStore.getState().projectPlugins?.settings.sites, { counter: 20 });

      // A later change opens a new window.
      rig.setCounter(21);
      rig.notifier.notify();
      assert.equal(rig.timers.length, 1);
    } finally {
      unsubscribe();
    }
  });

  it("drops a refresh scheduled before another project was opened", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    rig.setCounter(2);
    rig.notifier.notify();
    // Opening project B replaces projectPlugins and bumps the generation before
    // the manager restores; the old project's live state must not overwrite it.
    const opened: ProjectPluginState = {
      activePluginIds: [],
      mapControlPositions: {},
      settings: { sites: { counter: 77 } },
      manifestUrls: [],
    };
    useAppStore.setState({
      projectPlugins: opened,
      isDirty: false,
      projectGeneration: useAppStore.getState().projectGeneration + 1,
    });
    rig.fire();
    assert.equal(useAppStore.getState().projectPlugins, opened);
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("still commits a refresh that fires in the same generation", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    rig.setCounter(2);
    rig.notifier.notify();
    rig.fire();
    assert.equal(useAppStore.getState().isDirty, true);
    assert.deepEqual(useAppStore.getState().projectPlugins?.settings.sites, { counter: 2 });
  });

  it("can drop a pending refresh", () => {
    const rig = makeRig();
    useAppStore.getState().setProjectPlugins(rig.snapshot(), false);
    rig.setCounter(2);
    rig.notifier.notify();
    rig.notifier.cancel();
    assert.equal(rig.timers.length, 0);
    rig.fire();
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("uses a short coalescing window by default", () => {
    assert.equal(PROJECT_STATE_NOTIFY_DELAY_MS, 250);
  });
});

describe("autosave predicate", () => {
  type AppState = ReturnType<typeof useAppStore.getState>;
  const base = useAppStore.getState();
  const withPlugins = (): AppState => ({
    ...base,
    projectPlugins: {
      activePluginIds: [],
      mapControlPositions: {},
      settings: { sites: { counter: 1 } },
      manifestUrls: [],
    },
  });

  it("fires on a projectPlugins change only with the setting on", () => {
    const next = withPlugins();
    assert.equal(projectAutosaveChanged(next, base, true), true);
    assert.equal(projectAutosaveChanged(next, base, false), false);
  });

  it("does not fire when projectPlugins is unchanged", () => {
    assert.equal(projectAutosaveChanged(base, base, true), false);
  });

  it("still fires on a camera or project change regardless of the setting", () => {
    const moved = { ...base, mapView: { ...base.mapView } };
    assert.equal(projectAutosaveChanged(moved, base, false), true);
    const renamed = { ...base, projectName: `${base.projectName} 2` };
    assert.equal(projectAutosaveChanged(renamed, base, false), true);
  });
});

describe("pluginStateAutosave setting", () => {
  it("is on by default in this distribution", () => {
    assert.equal(DEFAULT_PROJECT_SETTINGS.pluginStateAutosave, true);
  });

  it("falls back to the default and keeps an explicit boolean either way", () => {
    assert.equal(
      normalizeDesktopSettings({}).projects.pluginStateAutosave,
      DEFAULT_PROJECT_SETTINGS.pluginStateAutosave,
    );
    for (const value of [true, false]) {
      const projects = normalizeDesktopSettings({ projects: { pluginStateAutosave: value } })
        .projects;
      assert.equal(projects.pluginStateAutosave, value);
    }
  });

  it("ignores a non-boolean value", () => {
    const projects = normalizeDesktopSettings({ projects: { pluginStateAutosave: "no" } })
      .projects;
    assert.equal(projects.pluginStateAutosave, DEFAULT_PROJECT_SETTINGS.pluginStateAutosave);
  });
});
