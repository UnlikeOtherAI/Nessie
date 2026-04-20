import { Pool, type ClientConfig, type PoolConfig } from 'pg'

export const createPgPool = (
  connectionConfig: string | ClientConfig,
  options: Pick<PoolConfig, 'max' | 'min'> = {},
): Pool => {
  const pool = new Pool(
    typeof connectionConfig === 'string'
      ? { connectionString: connectionConfig, ...options }
      : { ...connectionConfig, ...options },
  )
  // Prevent unhandled 'error' crash when Postgres terminates an idle connection
  pool.on('error', (err) => {
    console.error('[pg-pool] idle client error — pool will reconnect:', err.message)
  })
  return pool
}
