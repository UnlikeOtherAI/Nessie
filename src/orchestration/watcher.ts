/**
 * src/orchestration/watcher.ts — Periodic health checks and stale task detection.
 * Runs on 60s interval, emits watcher.alert events.
 */

import { db } from '../db/database.js'

export interface WatcherAlert {
  id: string
  taskId: string
  type: 'stale' | 'loop' | 'runaway_spawn'
  message: string
  createdAt: number
}

export interface WatcherConfig {
  intervalMs: number
  staleThresholdMs: number
  loopWindowMs: number
  loopThreshold: number
  maxActiveSpawns: number
}

const DEFAULT_CONFIG: WatcherConfig = {
  intervalMs: 60_000,
  staleThresholdMs: 5 * 60_000,
  loopWindowMs: 10 * 60_000,
  loopThreshold: 4,
  maxActiveSpawns: 10,
}

type OnAlert = (alert: WatcherAlert) => void

export class Watcher {
  private config: WatcherConfig
  private onAlert: OnAlert
  private timer: ReturnType<typeof setInterval> | null = null
  private alerts: WatcherAlert[] = []
  /** Active alerts keyed by "type:taskId" — dedup across check intervals */
  private activeAlertKeys = new Set<string>()

  constructor(onAlert: OnAlert, config?: Partial<WatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onAlert = onAlert
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.config.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  check(): WatcherAlert[] {
    const found: WatcherAlert[] = []
    const currentKeys = new Set<string>()

    for (const alert of this.detectStaleTasks()) {
      const key = `${alert.type}:${alert.taskId}`
      currentKeys.add(key)
      if (!this.activeAlertKeys.has(key)) {
        found.push(alert)
      }
    }
    for (const alert of this.detectLoops()) {
      const key = `${alert.type}:${alert.taskId}`
      currentKeys.add(key)
      if (!this.activeAlertKeys.has(key)) {
        found.push(alert)
      }
    }
    for (const alert of this.detectRunawaySpawns()) {
      const key = `${alert.type}:${alert.taskId}`
      currentKeys.add(key)
      if (!this.activeAlertKeys.has(key)) {
        found.push(alert)
      }
    }

    // Update active set: add new, remove cleared
    this.activeAlertKeys = currentKeys

    for (const alert of found) {
      this.alerts.push(alert)
      this.onAlert(alert)
    }
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100)
    }
    return found
  }

  getAlerts(): WatcherAlert[] {
    return [...this.alerts]
  }

  private detectStaleTasks(): WatcherAlert[] {
    const cutoff = Date.now() - this.config.staleThresholdMs
    const rows = db.prepare(
      'SELECT id, label, status, updated_at FROM tasks'
      + ' WHERE status NOT IN (?, ?, ?) AND updated_at < ?',
    ).all('done', 'failed', 'cancelled', cutoff) as {
      id: string; label: string; status: string; updated_at: number
    }[]

    return rows.map(r => ({
      id: crypto.randomUUID(),
      taskId: r.id,
      type: 'stale' as const,
      message: `Task "${r.label}" stuck in ${r.status}`
        + ` for ${Math.round((Date.now() - r.updated_at) / 60_000)}min`,
      createdAt: Date.now(),
    }))
  }

  /**
   * Detect tasks with back-and-forth state transitions (revisiting previously-seen statuses).
   * A normal linear progression (inbox→assigned→in_progress→review→done) is NOT a loop.
   * Only repeated visits to the same status count toward the threshold.
   */
  private detectLoops(): WatcherAlert[] {
    const cutoff = Date.now() - this.config.loopWindowMs
    // Get events within the window, grouped by task
    const rows = db.prepare(
      'SELECT task_id, to_status FROM task_events'
      + ' WHERE timestamp > ? ORDER BY task_id, timestamp',
    ).all(cutoff) as { task_id: string; to_status: string }[]

    // Group by task and count revisits
    const taskEvents = new Map<string, string[]>()
    for (const r of rows) {
      const list = taskEvents.get(r.task_id) ?? []
      list.push(r.to_status)
      taskEvents.set(r.task_id, list)
    }

    const alerts: WatcherAlert[] = []
    for (const [taskId, statuses] of taskEvents) {
      // Count how many times a status was visited more than once
      const visits = new Map<string, number>()
      let revisits = 0
      for (const status of statuses) {
        const count = (visits.get(status) ?? 0) + 1
        visits.set(status, count)
        if (count > 1) revisits++
      }
      if (revisits >= this.config.loopThreshold) {
        alerts.push({
          id: crypto.randomUUID(),
          taskId,
          type: 'loop',
          message: `Task ${taskId} has ${revisits} repeated status revisits`
            + ` in ${this.config.loopWindowMs / 60_000}min`,
          createdAt: Date.now(),
        })
      }
    }
    return alerts
  }

  private detectRunawaySpawns(): WatcherAlert[] {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM tasks'
      + ' WHERE status IN (?, ?) AND parent_id IS NOT NULL',
    ).get('in_progress', 'assigned') as { cnt: number }

    if (row.cnt > this.config.maxActiveSpawns) {
      return [{
        id: crypto.randomUUID(),
        taskId: 'system',
        type: 'runaway_spawn',
        message: `${row.cnt} active child tasks exceeds threshold`
          + ` of ${this.config.maxActiveSpawns}`,
        createdAt: Date.now(),
      }]
    }
    return []
  }
}
