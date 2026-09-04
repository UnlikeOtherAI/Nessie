export type StructuralGateInput = { toolName: string; args: Record<string, unknown> }

export type StructuralGateResult =
  | { outcome: 'allow' }
  | {
      outcome: 'approval'
      reason?: string
      contextExtra?: Record<string, unknown>
      requiredApproverUserId?: string | null
    }
  | {
      /** A structural prerequisite is absent, so asking cannot repair it. */
      outcome: 'deny'
      message: string
      reason: string
    }
  | null

export type StructuralGate = (input: StructuralGateInput) => Promise<StructuralGateResult>

/**
 * Try each family's gate in order and take the first that claims the tool.
 *
 * Tool authorization accepts one hook, and a second family would otherwise
 * either replace the first or grow an `if` chain inside the authorizer that
 * every later family has to remember to extend. A gate returning null means
 * "not mine", which costs one comparison.
 */
export const composeStructuralGates = (gates: StructuralGate[]): StructuralGate =>
  async (input) => {
    for (const gate of gates) {
      const result = await gate(input)
      if (result) return result
    }
    return null
  }
