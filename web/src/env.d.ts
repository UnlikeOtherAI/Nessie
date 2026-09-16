/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin the signed-in team list is read from; defaults to https://api.nessie.works. */
  readonly VITE_NESSIE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
