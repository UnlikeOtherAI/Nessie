# Local LLM offload — Gemma 4 on the person's own machine

**Status: proposed (2026-09-18), with foundational primitives landed.** As of
2026-09-20, the pinned catalogue and executor Ollama detection/verified-import
client exist; the delegated inference/watch capability below is still proposed.

Scope extension: [Local Ollama agents](../2026-09-20-local-ollama-agents/overview.md)
adds explicit whole-agent model selection, direct desktop connectivity and
online/offline presence. This document continues to own bounded local offload;
its rejection of an agent lane applies only to that mode. The new plan also
consolidates the not-yet-shipped billing discriminator as `local_device`, with
a typed host reference, so both modes do not introduce competing local lanes.

The ask: cheap, recurring work — "check this every two minutes", "check that
every five minutes", "give me a wrap-up of what is happening in this tmux
session" — should run on the person's own computer on a small Gemma 4 model
instead of spending the organisation's Ledger credits on a frontier model.

The recommendation in one paragraph: the **executor** is the place, and the
shape is **delegation**. The frontier model on the server stays the
orchestrator of every conversation and keeps its full tool surface; the moment
a local model is `ready` on one of the person's executors, it is told it may
hand narrow, bounded tasks down — "watch this", "summarise that", "tell me when
something like this happens" — through one tool, `delegate_local`, which
becomes one executor operation, `local.delegate`. The local model acquires its
input **on the host** (a terminal buffer, a file tail, a command in the
executor's own guest VM, or text the orchestrator hands it), may call the same
executor operations the orchestrator can, with no approval gate in that path
(§2.9), and returns a schema-shaped answer plus token telemetry. The runtime is
**Ollama**, already assumed by the repo's own harness, never bundled; the
weights are **Gemma 4 GGUFs mirrored in our own Cloudflare R2 bucket**, pinned
by sha256 in code and downloaded once per machine — Nessie never hosts or
proxies the inference itself. A standing delegation ("every five minutes") is
the existing **`AgentTrigger`** / `schedule_task` machinery, not a second
scheduler, and wakes the orchestrator only when the local model reports a
change. The run record, the ledger row and the trigger-health alert stay on the
server; the raw source never leaves the machine. Metering is a **third billing
source** beside Ledger and personal subscriptions, reusing that lane's
*discipline* (structural `billingSource`, fail-closed pin, exclusion from org
cost by field) and none of its tables.

## Table of Contents

The design is one argument in five parts; each chapter is authoritative for
its own area, and this page is the map. Section numbers are stable — a
reference to "§2.9" means section 2.9, wherever it now lives.

- **[What exists today](what-exists-today.md)** — §1. The nine facts
  established by reading the code: inference resolution, the model catalogue
  and selection gate, personal subscriptions, the executor, scheduling,
  local-model prior art, Gemma and Cloudflare in the tree, the Gemma 4 and
  Ollama facts checked on 2026-09-18, and what Kelpie actually has.
- **[Shape of the feature](shape-of-the-feature.md)** — §2. Delegation, not
  routing; the third billing source; Ollama detected never bundled; the model
  catalogue and weights distribution; the executor side `local.delegate`; the
  delegation protocol; standing delegations; observation sources; metering,
  attribution and privacy; security and the trust boundary; and the reuse of
  Kelpie per component.
- **[Phasing](phasing.md)** — §3. Phase 0 measure, Phase 1 delegation on
  macOS, Windows and Linux, Phase 2 `guest.session`, Phase 3 bundled llama.cpp
  only if needed.
- **[Open questions](open-questions.md)** — §4. The decisions recorded for
  Ondrej, with the default each proceeds on.
- **[Not verified](not-verified.md)** — §5. What this document states without
  having verified it, stated plainly.
