import type { ProjectPluginState } from "@geolibre/core";

/** How long a burst of `notifyProjectStateChanged()` calls is merged into one refresh. */
export const PROJECT_STATE_NOTIFY_DELAY_MS = 250;

export interface ProjectStateNotifierDeps {
  /** The "Autosave changes made inside plugins" setting. */
  isEnabled: () => boolean;
  /** True while the plugin manager is restoring a project's plugin state. */
  isRestoring: () => boolean;
  /** The plugin state as the plugins would save it right now. */
  snapshot: () => ProjectPluginState;
  /** The plugin state the project currently holds. */
  stored: () => ProjectPluginState | null;
  /** Write the new plugin state into the project and mark it unsaved. */
  commit: (next: ProjectPluginState) => void;
  /**
   * Identifies the open project. A refresh scheduled under one generation is
   * dropped if the generation changed before it fires: a project open replaces
   * `projectPlugins` before the plugin manager restores, so snapshotting then
   * would write the old project's plugin state over the new one. A map rebuild
   * must not change it, or a pending user edit would be lost.
   */
  generation?: () => number;
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface ProjectStateNotifier {
  /** Request a refresh; calls inside the coalescing window share one. */
  notify: () => void;
  /** Drop a pending refresh. */
  cancel: () => void;
}

/**
 * Backs `app.notifyProjectStateChanged()`. The refresh is skipped (not
 * deferred) while a project is restoring or the setting is off, when a
 * different project was opened while it waited, and when the serialized plugin state already matches the project, so a plugin cannot mark
 * the project unsaved without an actual change to save.
 */
export function createProjectStateNotifier(deps: ProjectStateNotifierDeps): ProjectStateNotifier {
  const delayMs = deps.delayMs ?? PROJECT_STATE_NOTIFY_DELAY_MS;
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelTimer =
    deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: unknown = null;
  let hasPending = false;
  let scheduledGeneration = 0;

  const flush = (): void => {
    hasPending = false;
    pending = null;
    if ((deps.generation?.() ?? 0) !== scheduledGeneration) return;
    // Checked again here: the setting can flip, or a restore can start, while
    // the refresh waits.
    if (!deps.isEnabled() || deps.isRestoring()) return;
    const next = deps.snapshot();
    if (JSON.stringify(next) === JSON.stringify(deps.stored())) return;
    deps.commit(next);
  };

  return {
    notify: () => {
      if (!deps.isEnabled() || deps.isRestoring()) return;
      if (hasPending) return;
      hasPending = true;
      scheduledGeneration = deps.generation?.() ?? 0;
      pending = schedule(flush, delayMs);
    },
    cancel: () => {
      if (!hasPending) return;
      cancelTimer(pending);
      hasPending = false;
      pending = null;
    },
  };
}
