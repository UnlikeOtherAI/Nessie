import { Pool, type ClientConfig, type PoolConfig } from 'pg'

export const createPgPool = (
  connectionConfig: string | ClientConfig,
  options: Pick<PoolConfig, 'max' | 'min'> = {},
): Pool =>
  new Pool(
    typeof connectionConfig === 'string'
      ? {
          connectionString: connectionConfig,
          ...options,
        }
      : {
          ...connectionConfig,
          ...options,
        },
  )
