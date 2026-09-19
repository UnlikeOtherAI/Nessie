export type ResourceShareLifecycleErrorCode =
  | 'conflict'
  | 'denied'
  | 'invalid_target'
  | 'not_found'
  | 'sharing_disabled'

export class ResourceShareLifecycleError extends Error {
  constructor(public readonly code: ResourceShareLifecycleErrorCode) {
    super(code)
    this.name = 'ResourceShareLifecycleError'
  }
}

export const denyResourceShareLifecycle = (
  code: ResourceShareLifecycleErrorCode,
): never => {
  throw new ResourceShareLifecycleError(code)
}
