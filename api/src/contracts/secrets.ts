import { SecretRecordSchema, type SecretRecord } from '@nessie/schemas'

// The secret-metadata record the admin renders lives in `@nessie/schemas`
// (`secret-records.ts`) because the admin has no import path into `api/src`.
// Re-exported here so route modules keep one contract import.
export { SecretRecordSchema, type SecretRecord }
