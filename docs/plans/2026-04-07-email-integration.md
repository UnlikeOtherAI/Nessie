# Email Integration — SES

**Date:** 2026-04-07
**Status:** Superseded — see [2026-09-02-agent-email.md](2026-09-02-agent-email.md).
This predates the comms-connect stack, the `AgentTrigger`/delivery model, the
approval machinery, `FileService`, and the encrypted secret store; its address
scheme, BYO-SES AssumeRole path, `agents.email` column, and `integrations`
table are all replaced by the 2026-09-02 plan.

---

## Address scheme

**Platform-managed:**
`{agent-slug}@{org-slug}.agents.unlikeother.ai`

Examples:
- `coder@acme.agents.unlikeother.ai`
- `support-bot@globex.agents.unlikeother.ai`

Each agent gets one address on creation. Address is stored in the `agents` table.

**BYO-SES (enterprise):**
`{agent-slug}@agents.acme.com` — customer owns and verifies the domain.

---

## Least painful integration path

### Phase 1 — Platform-managed only (2–3 days)

Everything runs on Nessie's AWS account. No customer AWS involvement.

**AWS setup (one-time):**
1. Verify `agents.unlikeother.ai` in SES (domain verification + DKIM)
2. SES receiving rule: catch-all `*@agents.unlikeother.ai` → S3 bucket + SNS notification
3. SNS subscription: HTTP endpoint `POST /integrations/email/inbound` on Nessie backend

**Backend:**
1. On agent creation: assign `{agent-slug}@{org-slug}.agents.unlikeother.ai`, store in DB
2. `POST /integrations/email/inbound`: SNS handler
   - Verify SNS signature
   - Fetch raw email from S3 using the key in the notification
   - Parse `To:` header → look up agent by email address
   - Route: if agent has an email trigger workflow, fire it; else push as a direct message to the agent's thread
3. `send_email` tool: sends via SES SDK from the agent's platform address

**That's it for phase 1.** An agent can receive and send email.

---

### Phase 2 — BYO-SES (enterprise)

The key design decision: **do not require the customer to give Nessie their AWS access keys**. Use IAM role assumption instead.

**Customer setup (documented, one-time):**
1. Verify their domain in their own SES account (SES console, standard DNS records)
2. Create an SES receiving rule: store inbound email to an S3 bucket, publish to an SNS topic
3. Subscribe the SNS topic to Nessie's inbound webhook URL (`POST /integrations/email/inbound?orgId=xxx&token=yyy`)
4. Create an IAM role in their account:
   - Trust policy: allows `sts:AssumeRole` from Nessie's AWS account ID
   - Permission: `ses:SendEmail`, `ses:SendRawEmail` on their verified identity
5. Provide Nessie with: `domain`, `roleArn`, `region`

**Nessie stores per org:**
```typescript
type SesIntegration = {
  orgId: string
  mode: 'platform' | 'byo'
  // BYO only:
  domain?: string          // agents.acme.com
  roleArn?: string         // arn:aws:iam::123456789:role/NessieSendRole
  region?: string          // us-east-1
  inboundWebhookToken: string  // secret token to verify inbound SNS calls
}
```

**Sending with BYO:**
```typescript
// Nessie assumes the customer's role before sending
const sts = new STSClient({ region })
const { Credentials } = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'nessie-send' }))
const ses = new SESClient({ region, credentials: fromTemporaryCredentials(Credentials) })
await ses.send(new SendEmailCommand({ From: `${agentSlug}@${domain}`, ... }))
```

**Why this is least painful for the customer:**
- No sharing of long-lived credentials
- IAM role is a standard AWS security pattern enterprise teams are familiar with
- Customer retains full control — they can revoke the role at any time
- Nessie never touches their other AWS resources

**Alternative for customers who don't want AWS involvement at all:**
- Set up email forwarding at DNS level (MX record → Nessie's inbound SMTP or SES)
- For sending, use Nessie's platform SES but with a custom `From` display name
- Loses true "from their domain" — the envelope sender is still unlikeother.ai
- Only suitable for smaller or less regulated deployments

---

## Email as a trigger

On the Trigger node, subtype `email`:

| Property | Type | Description |
|----------|------|-------------|
| `addressPattern` | string | Which address(es) fire this trigger. Supports wildcards: `*@acme.agents.unlikeother.ai`, exact match, or a specific agent address |
| `subjectFilter` | regex | Optional — only fire on emails whose subject matches |
| `fromFilter` | string | Optional — only fire when sender matches (domain or exact) |

Trigger payload available to downstream nodes:
```typescript
{
  email: {
    from: string
    to: string[]
    subject: string
    body: { text: string, html?: string }
    attachments: { filename: string, contentType: string, s3Key: string }[]
    receivedAt: string   // ISO timestamp
    messageId: string
  }
}
```

Attachments are not inlined into the payload — they are stored in S3 and referenced by key. An agent can call `FileRead` with the S3 key if it needs the content.

---

## `send_email` tool

Added to the tool catalog alongside Bash, FileRead, etc.

```typescript
{
  name: 'send_email',
  description: 'Send an email from this agent\'s address',
  inputSchema: z.object({
    to: z.array(z.string()),
    subject: z.string(),
    body: z.string(),          // plain text
    bodyHtml: z.string().optional(),
    replyTo: z.string().optional(),
    attachments: z.array(z.object({
      filename: z.string(),
      path: z.string(),        // local file path or S3 key
    })).optional(),
  })
}
```

The tool resolves the sending identity (platform or BYO) from the agent's org integration config.

---

## DB additions

```sql
-- Integration config per org
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'ses_email' | 'slack' | future integrations
  mode TEXT NOT NULL,          -- 'platform' | 'byo'
  config TEXT NOT NULL,        -- encrypted JSON (domain, roleArn, region, etc.)
  webhook_token TEXT NOT NULL, -- token to verify inbound SNS/webhook calls
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agent email addresses
ALTER TABLE agents ADD COLUMN email TEXT;  -- assigned on creation
```

---

## MCP additions

| Tool | Description |
|------|-------------|
| `send_email` | Send an email from the agent's address |
| `integration.ses.configure` | Configure BYO-SES for an org (admin only) |
| `integration.ses.verify` | Check domain verification status |
| `integration.ses.test` | Send a test email to verify the integration |

---

## Implementation order

1. SES domain verification for `agents.unlikeother.ai` (AWS console, one-time)
2. SES receiving rule → S3 + SNS (AWS console or CDK, one-time)
3. `POST /integrations/email/inbound` route — SNS handler, email parser, agent routing
4. `send_email` tool — platform mode only
5. Agent email address assignment on creation
6. Email trigger subtype on Trigger node
7. BYO-SES: `integrations` table, IAM role assumption for sending
8. BYO-SES: inbound webhook token verification, per-org routing
9. Admin UI: BYO-SES configuration page
