import type { useAppStore } from "@geolibre/core";
import { projectChanged } from "./project-broadcast-changed";

type AppState = ReturnType<typeof useAppStore.getState>;

/**
 * Did the store change in a way the local autosave / project history should
 * snapshot? This is the broadcast predicate (`projectChanged`) plus the camera,
 * which a local snapshot records but a collaboration broadcast must not send.
 *
 * `projectPlugins` (each plugin's saved settings) is watched only when
 * `pluginStateAutosave` is on: a plugin that calls
 * `app.notifyProjectStateChanged()` refreshes it, and without this its change
 * would sit unsaved until some unrelated edit triggered a snapshot. It stays out
 * of `projectChanged` on purpose: plugin settings are participant-local, so they
 * must not trigger a collaboration broadcast.
 */
export function projectAutosaveChanged(
  state: AppState,
  previous: AppState,
  pluginStateAutosave: boolean,
): boolean {
  return (
    projectChanged(state, previous) ||
    state.mapView !== previous.mapView ||
    (pluginStateAutosave && state.projectPlugins !== previous.projectPlugins)
  );
}
