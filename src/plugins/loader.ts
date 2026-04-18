/**
 * src/plugins/loader.ts — Plugin loader with activation-aware semantics.
 *
 * Port of OpenClaw PR #68638:
 * Non-activating plugin loads (`activate: false`) must NOT execute `register(api)`
 * side effects. This prevents state pollution before the loader can roll back.
 *
 * Pattern: short-circuit before `runPluginRegisterSync()` when `shouldActivate === false`.
 */

export interface PluginMetadata {
  id: string
  loadedAt: number
  activated: boolean
}

/**
 * Minimal plugin API surface used during registration.
 * Expand as the plugin system matures.
 */
export interface PluginApi {
  // Placeholder — extend as needed
  [key: string]: unknown
}

/**
 * PluginLoader manages plugin loading with explicit activation control.
 *
 * When `activate === false`:
 *   - Records plugin metadata and tracks seen IDs only
 *   - Does NOT call `register(api)` — short-circuits before side effects
 *
 * When `activate === true`:
 *   - Calls `register(api)` to activate the plugin normally
 */
export class PluginLoader {
  private seenIds = new Set<string>()
  private metadata: Map<string, PluginMetadata> = new Map()

  /**
   * Load a plugin, optionally activating it.
   *
   * @param pluginId Unique identifier for the plugin
   * @param activate Whether to run the plugin's `register` function
   */
  loadPlugin(pluginId: string, activate: boolean): void {
    // Always track the plugin as seen
    this.seenIds.add(pluginId)

    // Always record metadata (non-activating loads still track the plugin)
    this.metadata.set(pluginId, {
      id: pluginId,
      loadedAt: Date.now(),
      activated: activate,
    })

    // Short-circuit: non-activating loads do NOT call register(api)
    // This is the key fix from OpenClaw PR #68638 — prevents side effects
    // from running when the plugin is not meant to be activated.
    if (!activate) {
      return
    }

    // Activating load: call register(api) normally
    this.runPluginRegisterSync(pluginId)
  }

  /**
   * Actually execute the plugin's registration function.
   * Only called when `activate === true`.
   */
  private runPluginRegisterSync(pluginId: string): void {
    // Placeholder: in a real implementation, this would dynamically import
    // the plugin module and call its register function with a PluginApi.
    // For now, this is a skeleton that documents the pattern.
    console.debug(`[PluginLoader] Activating plugin: ${pluginId}`)
  }

  /**
   * Returns all plugin IDs that have been loaded (regardless of activation).
   */
  getSeenIds(): string[] {
    return Array.from(this.seenIds)
  }

  /**
   * Returns metadata for a specific plugin, or undefined if not loaded.
   */
  getMetadata(pluginId: string): PluginMetadata | undefined {
    return this.metadata.get(pluginId)
  }

  /**
   * Returns all plugin metadata.
   */
  getAllMetadata(): PluginMetadata[] {
    return Array.from(this.metadata.values())
  }
}
