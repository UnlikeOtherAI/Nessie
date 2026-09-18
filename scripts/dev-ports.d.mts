// Types for `dev-ports.mjs`, which stays plain ESM because plain Node scripts
// (the `predev` guard) run it without a build step, while `admin/vite.config.ts`
// imports it under `checkJs: false`.

export declare const DEFAULT_API_PORT: number
export declare const DEFAULT_ADMIN_PORT: number
export declare const API_PORT_ENV: 'NESSIE_API_PORT'
export declare const ADMIN_PORT_ENV: 'NESSIE_ADMIN_PORT'
export declare const REPO_ROOT: string
export declare const ROOT_ENV_PATH: string

export declare const readEnvFileValue: (key: string, filePath?: string) => string | null
export declare const parsePort: (raw: string | number, source: string) => number

export declare const resolveApiPort: (
  env?: Record<string, string | undefined>,
  envFilePath?: string,
) => number

export declare const resolveAdminPort: (
  env?: Record<string, string | undefined>,
  envFilePath?: string,
) => number

export declare const resolveDevPorts: (
  env?: Record<string, string | undefined>,
  envFilePath?: string,
) => { admin: number; api: number }
