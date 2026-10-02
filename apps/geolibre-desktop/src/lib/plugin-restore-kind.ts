/**
 * Whether a plugin-state restore follows a project load rather than a map
 * rebuild: the project generation differs from the one last restored (or none
 * has been restored yet). A map rebuild (renderer or basemap swap) only changes
 * the map-ready generation, so it restores under the same project generation.
 * The very first restore at generation 0 (nothing opened yet) is not a load:
 * resetting then would wipe state a plugin restored itself at startup.
 *
 * @param restoredGeneration - The project generation last restored onto a map.
 * @param projectGeneration - The current project generation.
 * @returns True when the restore is for a newly loaded project.
 */
export function isProjectLoadRestore(
  restoredGeneration: number | null,
  projectGeneration: number,
): boolean {
  if (restoredGeneration === null) return projectGeneration > 0;
  return restoredGeneration !== projectGeneration;
}
