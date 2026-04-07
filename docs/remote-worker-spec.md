# Remote Worker Execution CLI

> Status: target-state design.

## 1) Objective

Add a customer-installed execution client for macOS, Windows, and Linux that can register with a parent Nessie control plane and expose controlled local execution capabilities to managed agents.

The parent control plane may be:

- Nessie Cloud,
- a self-hosted Nessie deployment,
- organization-owned infrastructure,
- any compatible parent instance that implements the same control contract.

This is not the same thing as the hosted `runner` service:

- `runner`: Nessie-owned isolated execution boundary in cloud infrastructure.
- `remote worker`: customer-owned machine agent that voluntarily exposes a limited execution surface back to the Nessie control plane.

## 2) Core model

Introduce a first-class resource:

- `RemoteWorker`

Required fields:

- `remoteWorkerId`
- `organizationId`
- `projectId` or explicit shared scope
- `parentInstanceId`
- `label`
- `platform`: `macos | windows | linux`
- `status`: `pending | online | idle | busy | draining | offline | revoked`
- `lastSeenAt`
- `capabilities`
- `localPolicyVersion`
- `cloudPolicyVersion`
- `agentBindings`
- `channelBindings`
- `tags`
- `authMode`

The execution client should be installable as a CLI or lightweight background service.

## 3) Connection model

### 3.1 Registration

The execution CLI must be able to:

1. bootstrap with a one-time registration token,
2. generate a local worker identity,
3. register machine metadata and local capabilities,
4. receive a `remoteWorkerId` and short-lived auth material,
5. store only the minimum local credentials required for reconnect.

Parent setup requirements:

- the worker must know the parent control-plane URL,
- the worker must know or receive a bootstrap credential,
- the parent must mint a worker-scoped API key or equivalent short-lived credential chain,
- long-lived org or operator keys must not be embedded directly into the worker config.

Suggested auth flow:

1. operator creates a registration token or worker-scoped API key in the parent instance,
2. worker performs bootstrap handshake,
3. parent returns:
   - `remoteWorkerId`,
   - `parentInstanceId`,
   - short-lived access token,
   - refresh or re-bootstrap policy,
   - current cloud policy digest,
   - websocket endpoint metadata.

### 3.2 Idle behavior

When idle, the remote worker should not hold a permanent websocket open by default.

Instead it should:

- poll a tiny control endpoint on a short interval,
- send heartbeat and capability digest,
- send updated local policy/sandbox digest whenever local config changed,
- ask whether work is waiting.

Recommended default:

- heartbeat every `60s`,
- server may return `retryAfterMs` to lengthen or shorten the next tick,
- emergency wake path can be added later, but is not required for v1.

Suggested response shape:

```json
{
  "hasWork": true,
  "retryAfterMs": 5000,
  "wsTicket": "short-lived-ticket",
  "sessionId": "sess_123",
  "requestedMode": "interactive",
  "policyChanged": false,
  "policyVersion": "pol_v12"
}
```

### 3.3 Handshake and policy synchronization

At handshake time, and whenever local policy changes, the worker must transmit to the parent:

- capability list,
- local hard-policy summary,
- local sandbox roots,
- disabled tool classes,
- current local policy version or digest,
- platform/runtime metadata.

The parent must return:

- accepted policy version,
- cloud-side restrictions relevant to this worker,
- effective-policy digest,
- whether any active bindings are now invalid.

If local or parent policy changes invalidate an open session:

- new commands must be blocked immediately,
- existing sessions may be interrupted or drained according to policy,
- audit must record the reason.

### 3.4 Active work behavior

When the poll response indicates pending work, the remote worker opens a websocket to the control plane and joins the assigned session.

The websocket is used for:

- command envelopes,
- stdin/stdout streaming,
- file operation requests,
- progress events,
- session interrupt/close events,
- policy challenge or approval-required events.

When no active work remains:

- the websocket closes,
- the worker returns to heartbeat mode,
- resumable session state is retained only if policy allows it.

## 4) Execution surfaces

The remote worker may expose any subset of these capabilities:

- `shell.run`
- `shell.session`
- `file.read`
- `file.write`
- `file.glob`
- `process.list`
- `process.signal`
- `ssh.run`
- `ssh.session`
- `mcp.proxy`
- `cli.wrapper`

The exact enabled set is machine-local and must be declared during registration and every heartbeat.

Capabilities must be modeled as declarative tool surfaces, not raw unrestricted shell access.

## 5) Policy model

### 5.1 Three-layer effective permission

Effective permission for any remote action is the intersection of:

1. local hard policy on the machine,
2. cloud policy in Nessie,
3. current actor context at execution time.

If any layer denies the action, execution is denied.

### 5.2 Local hard policy

The local execution CLI must support immutable or operator-controlled flags/config that the cloud cannot override.

Examples:

- disable all write tools,
- allow access only inside specific roots,
- deny network tools,
- deny SSH entirely,
- allow only certain wrapped commands,
- require local confirmation for interactive sessions,
- deny access outside working hours,
- force read-only mode.

The worker must also be able to sandbox itself to specific folders and report that sandbox summary to the parent during handshake and policy updates.

This is the machine owner's firewall. The cloud may narrow permissions further, but it must never expand beyond local hard policy.

### 5.3 Cloud policy

Cloud policy should support parallel restriction layers:

- org policy,
- project policy,
- team policy,
- channel policy,
- agent policy,
- tool policy,
- remote-worker policy,
- explicit binding overrides.

Examples:

- agent `deploy-bot` may use `shell.run` on worker `build-mac-01`,
- channel `incident-response` may use read-only file tools on worker `ops-linux-02`,
- reviewer agents may inspect logs but not write files,
- one project may see a worker while another project cannot discover it,
- the parent may mark a worker as drain-only or read-only without changing the worker's local config.

### 5.4 Effective policy output

Every remote execution request should resolve to an auditable decision:

- `allowed`
- `denied`
- `requires_approval`
- `requires_step_up_verification`

With reason codes such as:

- `REMOTE_WORKER_OFFLINE`
- `LOCAL_POLICY_DENY`
- `CLOUD_POLICY_DENY`
- `MISSING_AGENT_BINDING`
- `MISSING_CHANNEL_BINDING`
- `TOOL_NOT_EXPOSED`
- `PATH_OUTSIDE_ALLOWED_ROOT`
- `INTERACTIVE_SESSION_DISABLED`

## 6) Session model

Remote-worker sessions should align with the same control-plane session family used for local interactive tools.

Required actions:

- `remoteWorker.register`
- `remoteWorker.heartbeat`
- `remoteWorker.connect`
- `remoteWorker.disconnect`
- `remoteWorker.drain`
- `remoteWorker.revoke`
- `remoteWorker.session.start`
- `remoteWorker.session.send`
- `remoteWorker.session.read`
- `remoteWorker.session.interrupt`
- `remoteWorker.session.close`

One-shot operations should also be possible without a long session:

- `remoteWorker.exec`
- `remoteWorker.file.read`
- `remoteWorker.file.write`

Interactive mode and one-shot mode can share the same worker, but they must still pass through the same policy resolver.

## 7) Sandboxing requirements

Local policy must support machine-level constraints such as:

- allowed roots,
- denied roots,
- read-only outside allowlisted roots,
- env allowlist/denylist,
- command allowlist,
- command denylist,
- maximum runtime,
- maximum output size,
- maximum concurrent sessions,
- no-pty mode,
- no-interactive mode.

Cloud policy may add stricter limits, but never weaker ones.

## 8) Security requirements

- The remote worker must authenticate with short-lived credentials after registration.
- Registration tokens must be single-use and time-limited.
- Worker API keys must be scoped to one worker or one bootstrap operation, never to a whole organization.
- Every remote command must carry actor, project, channel, agent, and tool context.
- Secrets must never be pushed in plaintext over chat; only `secretRef`-based resolution is allowed at execution time.
- The remote worker should not accept direct inbound connections from the public internet for v1.
- All remote execution is control-plane initiated from the worker's outbound connection.
- Worker revocation must immediately block new sessions and invalidate reconnect tokens.
- Local policy/config changes must be integrity-protected before the parent accepts them as the new worker state.

## 9) API and transport requirements

HTTP endpoints:

- `POST /remote-workers/register`
- `POST /remote-workers/{remoteWorkerId}/heartbeat`
- `POST /remote-workers/{remoteWorkerId}/policy-sync`
- `POST /remote-workers/{remoteWorkerId}/drain`
- `POST /remote-workers/{remoteWorkerId}/revoke`
- `GET /remote-workers`
- `GET /remote-workers/{remoteWorkerId}`
- `GET /remote-workers/{remoteWorkerId}/policy/effective`
- `POST /remote-workers/{remoteWorkerId}/access/check`

Websocket path:

- `GET /remote-workers/connect?ticket=...`

MCP parity:

- `remoteWorker.register`
- `remoteWorker.list`
- `remoteWorker.get`
- `remoteWorker.apiKey.create`
- `remoteWorker.apiKey.rotate`
- `remoteWorker.bind`
- `remoteWorker.unbind`
- `remoteWorker.policy.sync`
- `remoteWorker.policy.effective`
- `remoteWorker.exec`
- `remoteWorker.session.start`
- `remoteWorker.session.send`
- `remoteWorker.session.read`
- `remoteWorker.session.interrupt`
- `remoteWorker.session.close`

## 10) Governance and visibility

- Remote workers are project-scoped by default.
- Discovery must be membership-aware.
- Private/protected channels must not leak worker metadata to unauthorized users or agents.
- Agents may only use remote workers that are both:
  - visible to the current project/channel context,
  - explicitly bound by policy.

Remote workers should support tags such as:

- `desktop`
- `build`
- `staging`
- `prod-like`
- `read-only`
- `gpu`

## 11) Product boundaries

This feature should not become a general remote-access platform in v1.

Do not add, as baseline requirements:

- WireGuard mesh,
- TURN/STUN appliance complexity,
- LAN pairing workflows,
- device-to-device networking,
- arbitrary public inbound exposure.

For the first version, the remote worker is an outbound-executing control client with strict policy and auditability.

## 12) Parent-instance requirement

The remote worker must treat the configured parent instance as authoritative for orchestration, not necessarily as "the cloud."

That means:

- setup must capture the parent URL and bootstrap credential,
- the worker must identify which parent it belongs to,
- handshake and policy-sync events go to that parent,
- capabilities and sandbox limits are reported to that parent,
- effective policy is computed between worker-local policy and parent policy.

## 13) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [agent tool capabilities](./agent%20tool%20capabilities/index.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [functionality.md](./functionality.md)
