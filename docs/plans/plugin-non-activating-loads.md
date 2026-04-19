# Plugin Non-Activating Loads

**Date:** 2026-04-18
**Status:** Implemented
**Source:** OpenClaw PR #68638

---

## Overview

Plugin loading in Nessie has two distinct phases: **load** and **activate**.

- **Load** — read the plugin, validate its structure, run static checks
- **Activate** — register the plugin's hooks, tools, and handlers with the runtime

Some callers only need the **load** phase — to inspect plugin metadata, check capabilities, or validate existence — without activating the plugin into the runtime.

## The Problem

Previously, all plugin loads called `register()` unconditionally, even when the plugin would never be activated. This had two problems:

1. **Side effects in inspection code** — `register()` can have arbitrary side effects (opening connections, spawning resources). Running those during a simple inspection or validation pass is unnecessary and wasteful.

2. **Rollback complexity** — if `register()` succeeded but the caller later decided not to activate, the system had to roll back registered state, adding complexity to the plugin lifecycle.

## The Solution

`PluginLoader` introduces a **non-activating load** that short-circuits before `register()`:

```typescript
// Activating load — loads AND activates
const plugin = await PluginLoader.load(pluginPath, { activate: true })

// Non-activating load — loads only, no side effects
const info = await PluginLoader.load(pluginPath, { activate: false })
// info.plugin is populated
// info.manifest is populated
// register() is NOT called
```

### Flow

```
activate: true
  → Load plugin code
  → Validate manifest
  → runPluginRegisterSync(plugin)
  → Plugin is active

activate: false
  → Load plugin code
  → Validate manifest
  → [SHORT-CIRCUIT] — register() NOT called
  → Return plugin info only
```

## When to Use Each

| Use case | Load type |
|----------|-----------|
| Normal runtime initialization | `activate: true` |
| Plugin discovery / catalog | `activate: false` |
| Plugin validation / static analysis | `activate: false` |
| Capability checking | `activate: false` |
| Plugin admin UI (enable/disable) | `activate: false` (preview only) |

## API

```typescript
interface LoadOptions {
  activate: boolean
}

interface LoadResult {
  manifest: PluginManifest
  plugin: Plugin | null  // null if activate: false
  activated: boolean     // true if activate: true
}
```

## OpenClaw Compatibility

This pattern is sourced from OpenClaw PR #68638, which fixes issue #68615. It ensures that non-activating loads do not execute `register()` side effects, making plugin inspection safe and side-effect-free.