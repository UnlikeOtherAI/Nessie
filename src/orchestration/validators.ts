/**
 * src/orchestration/validators.ts — External validator adapters.
 * Run lint, typecheck, and test validators against task artifacts.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface ValidatorResult {
  name: string
  passed: boolean
  output: string
  durationMs: number
}

export interface Validator {
  name: string
  run(taskId: string, cwd: string): Promise<ValidatorResult>
}

class LintValidator implements Validator {
  name = 'lint'

  async run(_taskId: string, cwd: string): Promise<ValidatorResult> {
    const start = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(
        'pnpm', ['exec', 'eslint', 'src'],
        { cwd, timeout: 60_000 },
      )
      return {
        name: this.name,
        passed: true,
        output: stdout || stderr || 'No issues found',
        durationMs: Date.now() - start,
      }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string }
      return {
        name: this.name,
        passed: false,
        output: e.stdout || e.stderr || e.message,
        durationMs: Date.now() - start,
      }
    }
  }
}

class TypeCheckValidator implements Validator {
  name = 'typecheck'

  async run(_taskId: string, cwd: string): Promise<ValidatorResult> {
    const start = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(
        'pnpm', ['exec', 'tsc', '--noEmit'],
        { cwd, timeout: 60_000 },
      )
      return {
        name: this.name,
        passed: true,
        output: stdout || stderr || 'No type errors',
        durationMs: Date.now() - start,
      }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string }
      return {
        name: this.name,
        passed: false,
        output: e.stdout || e.stderr || e.message,
        durationMs: Date.now() - start,
      }
    }
  }
}

class TestValidator implements Validator {
  name = 'test'

  async run(_taskId: string, cwd: string): Promise<ValidatorResult> {
    const start = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(
        'pnpm', ['test'],
        { cwd, timeout: 120_000 },
      )
      return {
        name: this.name,
        passed: true,
        output: stdout || stderr || 'All tests passed',
        durationMs: Date.now() - start,
      }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string }
      return {
        name: this.name,
        passed: false,
        output: e.stdout || e.stderr || e.message,
        durationMs: Date.now() - start,
      }
    }
  }
}

export const BUILT_IN_VALIDATORS: Validator[] = [
  new LintValidator(),
  new TypeCheckValidator(),
  new TestValidator(),
]

export async function runValidators(
  taskId: string,
  cwd: string,
  validators: Validator[] = BUILT_IN_VALIDATORS,
): Promise<ValidatorResult[]> {
  const results: ValidatorResult[] = []
  for (const v of validators) {
    results.push(await v.run(taskId, cwd))
  }
  return results
}
