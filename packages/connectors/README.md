# @nessie/connectors

Manifest parser and validator for `NessieToolBundle` documents
(`docs/tool-registry-spec.md` §4.1).

This package is pure logic. It does not touch the database or any other
Nessie package — callers are responsible for persisting the normalised
records it returns.

## Usage

```ts
import { readFile } from 'node:fs/promises'
import {
  parseManifest,
  validateManifest,
  normalizeBundle,
} from '@nessie/connectors'

const text = await readFile('toolset.json', 'utf8')

// 1. Parse the raw text. Format is auto-detected; pass a hint if you know it.
const raw = parseManifest(text)               // or parseManifest(text, 'json')

// 2. Validate against the schema + signature.
const result = validateManifest(raw)
if (!result.ok) {
  for (const issue of result.errors) {
    console.error(`${issue.path || '<root>'}: ${issue.message}`)
  }
  process.exit(1)
}

if (result.signatureSupport === 'unimplemented') {
  console.warn(result.warnings.map((w) => w.message).join('\n'))
}

// 3. Project into records ready for DB insertion. Caller does the write.
const records = normalizeBundle(result.bundle)
```

## Supported formats

- `toolset.json`
- `toolset.yaml` / `toolset.yml`
- `toolset.md` with YAML frontmatter delimited by `---` on its own line. The
  Markdown body is ignored.

All three formats parse to the same canonical structure.

## Signatures

If `metadata.signature.type === 'sha256'`, the value must be the SHA-256 of
the canonical-JSON encoding of the manifest **with the `metadata.signature`
block removed**. Keys are sorted recursively before hashing so JSON, YAML
and Markdown sources produce the same digest.

If `metadata.signature.type === 'ed25519'`, verification is currently a
stub. The validator returns `signatureSupport: 'unimplemented'` plus a typed
warning rather than failing — callers should surface the warning in the
import UI.

## Errors

- `ManifestParseError` — raw text could not be parsed (malformed JSON / YAML,
  missing frontmatter delimiters). Carries `line`/`column` when available.
- `ManifestValidationError` — parsed value failed schema validation or the
  sha256 signature did not match. Carries `issues[]` with field paths.

Both are exported from the package root.

## Scripts

```
pnpm --filter @nessie/connectors build
pnpm --filter @nessie/connectors typecheck
pnpm --filter @nessie/connectors lint
pnpm --filter @nessie/connectors test
```
