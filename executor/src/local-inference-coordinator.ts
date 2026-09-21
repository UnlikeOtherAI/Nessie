import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { LocalInferenceResourceControl, LocalInferenceTermination } from '@nessie/schemas'
import { LocalInferenceTerminationSchema } from '@nessie/schemas'

import { ensureOwnerOnlyStateDirectory, assertOwnerOnlyStatePath, type StateSecurityDeps } from './state-security.js'

type CoordinatorState = {
  capacity: number; controlRevision: number; paused: boolean; resourceId: string | null
  pendingAction: 'pause' | 'resume' | null
}
type Slot = {
  owner: string
  pid: number
  state: 'reserved' | 'running' | 'confirmed' | 'uncertain'
  termination: LocalInferenceTermination | null
}

export type LocalInferenceCoordinatorLease = {
  bind: (termination: Omit<LocalInferenceTermination, 'confirmed'>) => Promise<void>
  finish: (confirmed: boolean) => Promise<void>
  releaseIdle: () => Promise<void>
}

const stateIsValid = (value: unknown): value is CoordinatorState => {
  if (!value || typeof value !== 'object') return false
  const state = value as CoordinatorState
  return Number.isInteger(state.capacity) && state.capacity >= 1 && state.capacity <= 16
    && Number.isInteger(state.controlRevision) && state.controlRevision >= 0
    && typeof state.paused === 'boolean' && (state.resourceId === null || typeof state.resourceId === 'string')
    && (state.pendingAction === null || state.pendingAction === 'pause' || state.pendingAction === 'resume')
}

const slotIsValid = (value: unknown): value is Slot => {
  if (!value || typeof value !== 'object') return false
  const slot = value as Slot
  return typeof slot.owner === 'string' && Number.isSafeInteger(slot.pid) && slot.pid > 0
    && ['reserved', 'running', 'confirmed', 'uncertain'].includes(slot.state)
    && (slot.termination === null || LocalInferenceTerminationSchema.safeParse(slot.termination).success)
}

const processIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/**
 * The same coordinator is opened by Desktop and every paired executor under
 * this OS account. Neither API origin, org, model nor executor chooses its path.
 * A slot has no timeout. Death of its process proves nothing about an Ollama
 * request already accepted over HTTP, so abandoned slots remain occupied.
 */
export class LocalInferenceCoordinator {
  private constructor(
    private readonly directory: string,
    private readonly security: StateSecurityDeps,
    readonly identity: { privateKey: string; publicKey: string },
  ) {}

  static async open(
    options: { directory?: string; security?: StateSecurityDeps } = {},
  ): Promise<LocalInferenceCoordinator> {
    const security = options.security ?? {}
    const directory = await ensureOwnerOnlyStateDirectory(
      options.directory ?? join(homedir(), '.nessie', 'local-inference'), security,
    )
    const path = join(directory, 'resource-key.json')
    const temporary = `${path}.${randomUUID()}.new`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        const keys = generateKeyPairSync('ed25519')
        await file.writeFile(JSON.stringify({
          privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
          publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        }))
        await file.sync()
      } finally { await file.close() }
      await assertOwnerOnlyStatePath(temporary, 'file', security)
      // Publishing only a complete key avoids a second process reading the
      // empty interval between exclusive creation and the first write.
      await link(temporary, path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { await unlink(temporary).catch(() => undefined) }
    await assertOwnerOnlyStatePath(path, 'file', security)
    const identity = JSON.parse(await readFile(path, 'utf8')) as { privateKey: string; publicKey: string }
    if (typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') {
      throw new Error('Local inference resource identity needs repair.')
    }
    const coordinator = new LocalInferenceCoordinator(directory, security, identity)
    await coordinator.mutate(async () => {
      if (await coordinator.read('control.json') === null) {
        await coordinator.replace('control.json', { capacity: 1, controlRevision: 0, paused: false, resourceId: null, pendingAction: null })
      }
    })
    return coordinator
  }

  async control(): Promise<CoordinatorState> {
    const state = await this.read('control.json')
    if (!stateIsValid(state)) throw new Error('Local inference resource control needs repair.')
    return state
  }

  async syncControl(control: LocalInferenceResourceControl, acknowledgedAction?: 'pause' | 'resume'): Promise<void> {
    await this.mutate(async () => {
      const current = await this.control()
      if (current.resourceId !== null && current.resourceId !== control.resourceId) {
        throw new Error('This OS account is already enrolled with a different inference resource.')
      }
      if (control.controlRevision < current.controlRevision) return
      await this.replace('control.json', {
        capacity: control.capacity, controlRevision: control.controlRevision,
        paused: current.pendingAction === 'pause' && acknowledgedAction !== 'pause' || control.paused,
        resourceId: control.resourceId,
        pendingAction: current.pendingAction === acknowledgedAction ? null : current.pendingAction,
      })
    })
  }

  /** An offline pause is durable before contacting Nessie; only explicit resume clears it. */
  async pause(): Promise<void> {
    await this.mutate(async () => {
      await this.replace('control.json', { ...await this.control(), paused: true, pendingAction: 'pause' })
    })
  }

  async resume(): Promise<void> {
    await this.mutate(async () => { await this.replace('control.json', { ...await this.control(), pendingAction: 'resume' }) })
  }

  /** Called only after the person explicitly confirms their Ollama requests stopped. */
  async confirmStopped(): Promise<void> {
    await this.mutate(async () => {
      for (let index = 0; index < 16; index += 1) {
        const name = `slot-${index}.json`
        const slot = await this.read(name)
        if (slot === null) continue
        if (!slotIsValid(slot)) throw new Error('Local inference slot metadata needs repair.')
        if (['reserved', 'running'].includes(slot.state) && processIsAlive(slot.pid)) {
          throw new Error('A Nessie host still owns an active request. Stop that host before confirming termination.')
        }
        if (slot.termination) {
          await this.replace(name, { ...slot, state: 'confirmed', termination: { ...slot.termination, confirmed: true } })
        } else await unlink(join(this.directory, name))
      }
    })
  }

  async healthReason(): Promise<'termination_uncertain' | null> {
    for (let index = 0; index < 16; index += 1) {
      const slot = await this.read(`slot-${index}.json`)
      if (slot === null) continue
      if (!slotIsValid(slot) || slot.state === 'uncertain'
        || slot.state !== 'confirmed' && !processIsAlive(slot.pid)) return 'termination_uncertain'
    }
    return null
  }

  async acquire(): Promise<LocalInferenceCoordinatorLease | null> {
    return this.mutate(async () => {
      const control = await this.control()
      if (control.paused || await this.healthReason()) return null
      // Count all slots, including those above a newly lowered limit: lowering
      // capacity drains existing calls rather than admitting under new indices.
      let occupied = 0
      const empty: number[] = []
      for (let index = 0; index < 16; index += 1) {
        if (await this.read(`slot-${index}.json`) === null) empty.push(index)
        else occupied += 1
      }
      if (occupied >= control.capacity) return null
      const index = empty[0]
      if (index === undefined) return null
      const name = `slot-${index}.json`
      const owner = randomUUID()
      await this.replace(name, { owner, pid: process.pid, state: 'reserved', termination: null } satisfies Slot)
      const update = async (fn: (slot: Slot) => Promise<void>): Promise<void> => this.mutate(async () => {
        const slot = await this.read(name)
        if (!slotIsValid(slot) || slot.owner !== owner) throw new Error('Local inference slot was fenced.')
        await fn(slot)
      })
      return {
        bind: (termination) => update(async (slot) => {
          if (slot.state !== 'reserved' || slot.termination) throw new Error('Local inference slot is already bound.')
          await this.replace(name, { ...slot, state: 'running', termination: { ...termination, confirmed: false } })
        }),
        finish: (confirmed) => update(async (slot) => {
          if (!slot.termination) throw new Error('Local inference slot is not bound.')
          await this.replace(name, {
            ...slot, state: confirmed ? 'confirmed' : 'uncertain', termination: { ...slot.termination, confirmed },
          })
        }),
        releaseIdle: () => update(async (slot) => {
          if (slot.state !== 'reserved' || slot.termination) throw new Error('An active local inference slot cannot expire.')
          await unlink(join(this.directory, name))
        }),
      }
    })
  }

  /** Replay terminal confirmations before opening another slot after a restart. */
  async flushTerminations(submit: (termination: LocalInferenceTermination) => Promise<void>): Promise<void> {
    for (let index = 0; index < 16; index += 1) {
      const name = `slot-${index}.json`
      const slot = await this.read(name)
      if (!slotIsValid(slot) || !slot.termination || !['confirmed', 'uncertain'].includes(slot.state)) continue
      await submit(slot.termination)
      if (slot.state !== 'confirmed') continue
      await this.mutate(async () => {
        const current = await this.read(name)
        if (slotIsValid(current) && current.owner === slot.owner && current.state === 'confirmed') {
          await unlink(join(this.directory, name))
        }
      })
    }
  }

  private async read(name: string): Promise<unknown | null> {
    const path = join(this.directory, name)
    try {
      await assertOwnerOnlyStatePath(path, 'file', this.security)
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  private async replace(name: string, value: unknown): Promise<void> {
    const path = join(this.directory, name)
    const temporary = `${path}.${randomUUID()}.new`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() }
    finally { await file.close() }
    try {
      await assertOwnerOnlyStatePath(temporary, 'file', this.security)
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => undefined) }
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const path = join(this.directory, 'mutation.lock')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let file
      try { file = await open(path, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.recoverMutationLock(path)
        await delay(10)
        continue
      }
      try {
        await file.writeFile(String(process.pid)); await file.sync()
        await assertOwnerOnlyStatePath(path, 'file', this.security)
        const owned = await lstat(path)
        try { return await fn() }
        finally {
          const current = await lstat(path)
          if (current.ino === owned.ino) await unlink(path)
        }
      } finally { await file.close() }
    }
    // Never reclaim a lock by age. An interrupted mutation is an explicit
    // repair condition; silently deleting it could race a suspended process.
    throw new Error('Local inference coordinator is busy or needs repair.')
  }

  private async recoverMutationLock(path: string): Promise<void> {
    const recoveryPath = join(this.directory, 'mutation-recovery.lock')
    let recovery
    try { recovery = await open(recoveryPath, 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error }
    try {
      const metadata = await lstat(path).catch(() => null)
      if (!metadata) return
      await assertOwnerOnlyStatePath(path, 'file', this.security)
      const pid = (await readFile(path, 'utf8')).trim()
      if (!/^[1-9][0-9]{0,9}$/.test(pid) || processIsAlive(Number(pid))) return
      if ((await lstat(path)).ino === metadata.ino) await unlink(path)
    } finally { await recovery.close(); await unlink(recoveryPath) }
  }
}
