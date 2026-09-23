# Command attachments

Back to the [protocol overview](overview.md).

A terminal command result is capped at 64 KiB and is structured JSON only. The
images a local program returns — a Kelpie screenshot is 0.1–0.9 MB — travel
beside it instead: the daemon takes them out of the result, keeps them on disk
beside its recovery journal, and uploads each on its own signed request before
the result's receipt. The result carries only references to them.

The shapes are in `packages/schemas/src/executor-attachments.ts`; the rules
the daemon applies when it extracts an image are in
[executor-local-mcp.md](../standards/executor-local-mcp.md) → "Images leave
the result on the machine".

## The reference

An image content item of an `mcp.call` result becomes

```json
{"type": "image", "mimeType": "image/png", "attachmentDigest": "sha256:<hex>", "byteLength": 13715}
```

`attachmentDigest` is SHA-256 over the decoded bytes, `mimeType` one of
`image/png`, `image/jpeg`, `image/webp`, `image/gif` and agreeing with the
bytes' magic, `byteLength` at most 4 MiB. Every other copy of the same base64
in the result becomes `[image: attachment sha256:<hex>]`. An image that is not
delivered is the text item `[image unavailable: <reason>]` instead, and so are
its copies. The result's receipt digest is computed over the result as it
carries these references.

## The request

`POST /api/executor-daemon/commands/attachment`
(`ExecutorDaemonCommandAttachmentRequestSchema`):

```json
{
  "connectionEpoch": "42",
  "executorId": "<executor id>",
  "attachment": {
    "commandId": "<command id>",
    "digest": "sha256:<hex>",
    "mimeType": "image/png",
    "byteLength": 13715,
    "occurredAt": "2026-09-23T10:00:00.000Z"
  },
  "dataBase64": "<padded standard base64 of exactly byteLength bytes>",
  "signature": "<base64url Ed25519>"
}
```

The signature is the paired machine key's, under its own domain:
`nessie.executor.daemon.attachment.v1\n` followed by the canonical JSON of
`{attachment, connectionEpoch, executorId}`. It is distinct from `receipt`,
so neither can stand in for the other. `dataBase64` is not signed: the digest
is, and the control plane recomputes it from the decoded bytes and checks
their magic against `mimeType` before it keeps anything. It answers
`{recorded: true}`.

Uploading the same command and digest again is the same attachment, not a
second one: that is what makes a re-upload after a restart safe. Late uploads
are the normal case the sidecars exist for, so a command that the control
plane already marked `unknown_outcome` still takes them, as it takes the late
receipt behind them.

## Ordering on the machine

1. The call's images are written as raw sidecars
   `<runtimeDir>/attachments/<commandId>/<sha256 hex>.bin` and fsynced while
   the command executes — before the `result_pending` journal entry that
   references them is saved.
2. In `result_pending`, every referenced image is uploaded before the
   receipt. Each upload's deadline grows with its size, and one result's
   uploads together fit `EXECUTOR_MCP_UPLOAD_BUDGET_MS`, which the command's
   expiry reserves for them (`@nessie/schemas` `executor-timing.ts`).
3. A 4xx answer is a refusal and terminal: the image's reference and markers
   become `[image unavailable: Nessie refused it (<message>)]`, the rewritten
   result is journaled before anything else is sent, and the refused upload is
   never made again. A fenced or stale connection (409
   `EXECUTOR_CONNECTION_FENCED` or `EXECUTOR_HEARTBEAT_STALE`), 408 and 429
   are not refusals of the image — the receipt behind it would fail the same
   way — and neither are a timeout or a 5xx: the poll fails and the next one
   delivers again from the same journal.
4. A sidecar that is missing or no longer matches its digest is withdrawn as
   lost, the same way as a refusal.
5. The receipt is sent. Once it is acknowledged the journal is cleared and
   then the command's sidecar folder is removed; a crash between the two
   leaves a folder no journal names.
6. At start, before its first poll, the daemon removes every sidecar folder
   except the one its journal still names. A journal it cannot read removes
   nothing.

A restart anywhere between steps 1 and 5 replays from the journal: a result
still `executing` becomes `EXECUTOR_COMMAND_UNKNOWN_OUTCOME` with no
references, and a `result_pending` one uploads its images again.
