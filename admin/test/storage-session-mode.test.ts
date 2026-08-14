import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadStoredTokenMode,
  storeToken,
} from '../src/lib/storage'

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()
  failTokenWrite = false

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    if (this.failTokenWrite && key === 'nessie.admin.token') {
      throw new Error('simulated storage failure')
    }
    this.values.set(key, value)
  }
}

test('stored session mode is token-bound and partial writes fail closed', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

  try {
    storage.setItem('nessie.admin.token', 'legacy-token')
    assert.equal(loadStoredTokenMode(), 'renewable')

    storeToken('renewable-token', 'renewable')
    assert.equal(loadStoredTokenMode(), 'renewable')
    storeToken('imported-token', 'imported')
    assert.equal(loadStoredTokenMode(), 'imported')

    storage.failTokenWrite = true
    assert.throws(() => storeToken('replacement-token', 'renewable'), /storage failure/)
    assert.equal(loadStoredTokenMode(), 'imported')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
