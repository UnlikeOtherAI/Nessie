# DeepTest native source adapter

Nessie's DeepTest adapter is a local, read-only source boundary. DeepTest owns
the authenticated connection to its service, the project and review authority,
external-inference consent, active-testing authorization, findings, and report.
The adapter never calls Nessie's API and never creates an `ExecutorCommand` or
command receipt. Source bytes and read results therefore cannot enter Nessie's
hosted command-result persistence.

The human doorway is DeepTest's local executor configuration. In Nessie source
mode, DeepTest launches the packaged Node runtime and fixed bundle as a child
of its local connector.

```text
<packaged-node> <runtime>/nessie-executor.cjs deeptest-source --source-grant-file <absolute owner-only deeptest-source-grant.json>
```

The command is part of the same bundled `nessie-executor.cjs` entry point as the
ordinary daemon. Packaged builds apply the existing runtime-integrity check
before accepting a frame. Workspace support itself needs only Git plus a paired
root whose local policy contains `file.list` and `file.read`; it does not imply
that Hyper-V, browser, command, coding, or network capabilities are present.
Linked Git worktrees are not supported in protocol version 1 because their
object database is outside the approved root.

The source child receives one credential-free projection, never the paired
executor state or its directory. `deeptest-source-grant.json` contains exactly
`executorId`, `workspaceRoot`, and `descriptor`; the descriptor contains only
its limits, operation keys, profiles, and revision. The file and its parent
must be owner-only, and the adapter accepts only that fixed filename by an
absolute path. It contains no API URL, connection epoch, machine key, native
helper path, or browser/Codex sandbox configuration.

Pairing and local-policy saves publish this projection under a cross-process
state mutation lock. A changed projection is removed before the authoritative
state changes and replaced only after that save succeeds. A connection-only
save preserves an existing valid, identical projection. If a failed policy save
or publication left the grant absent, later connection-only saves keep it absent.
Forgetting a pairing removes the projection before the paired state. Confirmed
Desktop cleanup also handles an orphan grant and removes remaining runtime drafts.
An existing pairing created by
an older release can publish or recover its projection through the same lock:

```text
"/absolute/path/to/nessie-runtime/node" \
  "/absolute/path/to/nessie-runtime/nessie-executor.cjs" \
  publish-deeptest-source-grant --state-dir "/absolute/path/to/paired-state"
```

Replace the runtime and paired-state paths first. The command prints the absolute
source-grant path for DeepTest configuration and requires no global executable
or pre-existing shell variables.
Each existing-state write also compares the paired state it originally read
with the state inside the lock. A delayed connection or configuration write
therefore cannot restore policy after a newer update or recreate a forgotten
pairing. An interrupted writer may leave `executor-state-mutation.lock` behind;
it blocks further mutations. After confirming that Nessie Desktop, its executor
daemon, and executor configuration commands are stopped, the owner may remove
that exact lock file and run the publication command again. The implementation
never guesses that a lock is stale or removes one automatically.

## Transport and binding

The child reads one JSON object per line from standard input and writes one JSON
object per line to standard output. An input frame is at most 1 MiB and a
serialized UTF-8 output frame is at most 20 MiB. The output ceiling supports
every admitted 2 MiB file even when JSON escaping expands each byte; a larger
multi-file answer becomes a typed `OUTPUT_BYTES_LIMIT` incomplete receipt. There is no local
listener, shell-string field, executable field, URL, credential, provider key,
or model operation. Closing standard input ends the adapter and releases every
snapshot. Snapshot bytes exist only in the child process's bounded memory, so
an abrupt process death leaves no source cache on disk.

Every request contains this exact base:

```ts
type Base = {
  account_id: string
  operation: string
  project_id: string
  protocol_version: 1
  request_id: string
  review_id: string
  session_id: string
}
```

The first request must be `hello`. Its account, project, review, and session
become the process binding. Every later request repeats all four and a mismatch
is `BINDING_MISMATCH`. DeepTest authenticates the remote connector before it
maps a file-plane call to this child; the repeated local binding prevents a
later frame or reused snapshot handle from crossing reviews.

Success and partial coverage use:

```ts
type Result = {
  protocol_version: 1
  request_id: string
  result: Record<string, unknown>
  status: 'ok' | 'incomplete'
}
```

An error uses:

```ts
type ErrorResult = {
  error: { code: string; message: string; retryable: boolean }
  protocol_version: 1
  request_id: string
  status: 'error'
}
```

The operation shapes are exact; unlisted keys are rejected.

| Operation | Additional request fields | Result |
| --- | --- | --- |
| `hello` | none | `capabilities`, `executor_id`, `protocol_version`, `workspace_label` |
| `source.snapshot` | `expected_commit` (40 lowercase hex), `expected_source_root` (absolute local path) | `snapshot_id`, `commit`, `manifest_digest`, `working_tree_state`, `coverage` |
| `source.inventory` | `snapshot_id`, optional decimal `cursor`, optional `max_entries` (1–500) | snapshot facts, `entries`, and `next_cursor` |
| `source.read` | `snapshot_id`, `paths` (at most 256) | one result for every requested path |
| `source.release` | `snapshot_id` | `released: true` and the released id |

The capability list in version 1 is exactly `source.snapshot`,
`source.inventory`, `source.read`, and `source.release`.

## Snapshot and coverage

`source.snapshot` resolves the configured workspace and DeepTest's settled
local source root again and requires them to be the same repository root. Before
any Git command it validates local config plus HEAD, refs, reftable, shallow,
packed-refs, and the complete object database as contained ordinary metadata.
This rejects crafted pointers, metadata links, config includes, shared object
databases, and linked worktrees. Every Git call fixes `--git-dir` and
`--work-tree`. Git runs with
system/global config, replacement objects, lazy promisor fetch, credential
prompts, pagers, fsmonitor, and optional locks disabled. The adapter requests no
remote operation.

The adapter pins `HEAD` by commit and reads the exact tree's blobs by immutable
object id. Each admitted blob is hash-verified and retained in memory. The
manifest digest covers the commit, every inventory entry, every exclusion, and
the clean/dirty state observed before and after the snapshot. A changed commit
or changed dirty state during capture is `SOURCE_CHANGED`; uncommitted files are
not part of the snapshot, and `working_tree_state: 'dirty'` tells DeepTest to
say so. Because `expected_commit` is mandatory, the declared scope is that
committed tree and dirty metadata remains informational rather than making the
requested committed scope incomplete.

The inventory includes every encountered tree entry. Each entry contains
`status: 'readable' | 'excluded'`, byte count, digest when available, UTF-8 path
or base64 path bytes, and an exclusion reason. Version 1 reasons are
`binary_file`, `content_not_utf8`, `file_too_large`, `path_not_utf8`, `path_unsupported`,
`snapshot_byte_limit`, `submodule`, `symbolic_link`, and `unsupported_mode`.
Any excluded entry makes snapshot, inventory, and affected reads
`status: 'incomplete'`; consumers must not present whole-repository coverage.

An individual file is capped at 2 MiB and admitted snapshot content at 128 MiB.
Serialized protocol frames and normal runtime bookkeeping add to process RSS.
The tree is capped at 10,000 entries, an inventory page at 500 entries, a read
at 256 paths, and returned content at 16 MiB. Hitting a whole-tree bound refuses the
snapshot with `SOURCE_INVENTORY_LIMIT`. Hitting the read-content bound returns
an incomplete `READ_BYTES_LIMIT` receipt so the caller can split the request.
Missing and excluded requested paths each receive their own excluded result;
none disappear from the answer.

## Authorization ownership

The paired Nessie root and local `file.list`/`file.read` policy are the source
grant ceiling. The adapter rereads the credential-free source grant for every request and between
blob loads; a changed root, executor, policy revision, or withdrawn capability
invalidates access. Revocation clears retained snapshots, and transport closure
releases them. These grants allow no provider inference and no live execution. DeepTest
must retain its separate, user-visible provider/material policy and active-test
authorization. This adapter cannot write, promote, run a command, open a
browser, dial a URL, patch assessed code, or commit it.
