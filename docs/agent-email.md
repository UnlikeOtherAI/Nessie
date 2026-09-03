# Agent email — hosted mailboxes on Amazon SES

Hosted agent mailboxes give each agent its own address (`support@nessie.works`),
so people can CC an agent into an email thread and it can reply. This is the
operator guide: AWS setup, configuration, verification and the operating rules.

Design and invariants: [plans/2026-09-02-agent-email.md](plans/2026-09-02-agent-email.md)
and `CLAUDE.md` → "Agent email". Deployment overview:
[deployment/configuration.md](deployment/configuration.md) → "Agent email (Amazon SES)".

Amazon SES is integrated **directly**: the deployment's own SES account sends
and receives, there is no intermediary service, and an address is therefore
unique per deployment.

This is one of two ways an agent gets email. For a mailbox that already exists
somewhere else — a person's own, or a team's shared `support@` on any provider —
see [connected-mailboxes.md](connected-mailboxes.md); nothing is configured by
an operator there and no mail is stored in Nessie.

The feature is **off unless configured**, and partial configuration is named
rather than degraded: the claim flow refuses with `AGENT_MAIL_UNCONFIGURED`
listing exactly which variables are missing, the agent's Email section shows an
owner that same list, the inbound route answers `503`, and the worker logs
`[worker.agent-email] disabled` at boot and registers no handlers.

## AWS setup (one-time, per deployment)

All of it in **one region** — SES inbound receipt rules are regional, and the
bucket, topic and identity must live together.

1. **Verify the sending domain.** SES → *Verified identities* → create a domain
   identity for e.g. `nessie.works` with **Easy DKIM (RSA 2048)**, then publish
   the three CNAME records it gives you. Wait for *Verified*; startup refuses to
   enable on an unverified identity.
   ```bash
   aws sesv2 create-email-identity --email-identity nessie.works \
     --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT
   aws sesv2 get-email-identity --email-identity nessie.works \
     --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'
   ```
2. **Leave the sandbox.** A new SES account can only send to verified addresses.
   Request production access before anyone expects outbound mail to work.
3. **Point MX at SES inbound**, so mail for the domain reaches you at all:
   ```
   nessie.works.  MX  10 inbound-smtp.<region>.amazonaws.com.
   ```
   Publish SPF and DMARC beside it (`v=spf1 include:amazonses.com ~all`;
   `v=DMARC1; p=quarantine; rua=mailto:dmarc@nessie.works`).
4. **Create the S3 bucket for raw inbound MIME** and let SES write to it. The
   bucket is *transport staging only* — the pipeline parses each message, stores
   its attachments through `FileService`, and deletes the raw object after
   `NESSIE_EMAIL_INBOUND_RETENTION_DAYS`. Block all public access; enable
   default encryption.
   ```bash
   aws s3api create-bucket --bucket nessie-mail-inbound --region <region> \
     --create-bucket-configuration LocationConstraint=<region>
   aws s3api put-public-access-block --bucket nessie-mail-inbound \
     --public-access-block-configuration \
     "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
   ```
   Bucket policy — scope it to SES and to your account, never `Principal: "*"`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Service": "ses.amazonaws.com" },
       "Action": "s3:PutObject",
       "Resource": "arn:aws:s3:::nessie-mail-inbound/*",
       "Condition": {
         "StringEquals": { "AWS:SourceAccount": "<account-id>" },
         "StringLike": { "AWS:SourceArn": "arn:aws:ses:<region>:<account-id>:receipt-rule-set/*" }
       }
     }]
   }
   ```
5. **Create the SNS topic** both inbound receipts and delivery events publish
   to, and restrict who may publish to it:
   ```bash
   aws sns create-topic --name nessie-mail
   ```
   Topic policy: `Allow` `SNS:Publish` to `Service: ses.amazonaws.com` with
   `AWS:SourceAccount` equal to your account id, and nothing else.
6. **Create the receipt rule set and a catch-all rule** — S3 first, then SNS, so
   the notification never arrives before the object it names:
   ```bash
   aws ses create-receipt-rule-set --rule-set-name nessie
   aws ses create-receipt-rule --rule-set-name nessie --rule '{
     "Name": "catch-all",
     "Enabled": true,
     "TlsPolicy": "Require",
     "ScanEnabled": true,
     "Recipients": ["nessie.works"],
     "Actions": [
       {"S3Action": {"BucketName": "nessie-mail-inbound", "ObjectKeyPrefix": "inbound/"}},
       {"SNSAction": {"TopicArn": "arn:aws:sns:<region>:<account-id>:nessie-mail", "Encoding": "UTF-8"}}
     ]
   }'
   aws ses set-active-receipt-rule-set --rule-set-name nessie
   ```
   Keep `ScanEnabled` on: those spam and virus verdicts are what stop hostile
   mail from autonomously waking an agent.
7. **Create the configuration set** so bounces and complaints come back. Without
   this the suppression list stays empty and the deployment keeps mailing
   addresses that already hard-bounced, burning its own sending reputation.
   ```bash
   aws sesv2 create-configuration-set --configuration-set-name nessie-mail
   aws sesv2 create-configuration-set-event-destination \
     --configuration-set-name nessie-mail \
     --event-destination-name sns \
     --event-destination '{
       "Enabled": true,
       "MatchingEventTypes": ["BOUNCE","COMPLAINT","DELIVERY"],
       "SnsDestination": {"TopicArn": "arn:aws:sns:<region>:<account-id>:nessie-mail"}
     }'
   ```
8. **Subscribe the API.** Nessie subscribes itself to the configured topic at
   startup, and the public route **rejects** `SubscriptionConfirmation` messages
   outright — a confirmation arriving there is either unnecessary or a stranger
   probing for a live endpoint. If you subscribe by hand instead, point the
   HTTPS subscription at `https://api.<your-domain>/api/integrations/email/inbound`.

**IAM.** The API/worker need `ses:SendEmail`, `ses:GetEmailIdentity`,
`sns:Subscribe`/`sns:ListSubscriptionsByTopic` on the topic, and
`s3:GetObject`/`s3:DeleteObject` on the inbound prefix — plus
`ses:CreateEmailIdentity` only if you enable custom domains. Prefer an instance
profile or IRSA role over static keys: leave `NESSIE_EMAIL_SES_ACCESS_KEY_ID`
and `NESSIE_EMAIL_SES_SECRET_ACCESS_KEY` unset and the AWS SDK default
credential chain applies.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `NESSIE_EMAIL_SES_REGION` | yes | SES region. Everything above lives in it. |
| `NESSIE_EMAIL_DOMAIN` | yes | Default mail domain (`nessie.works`). Must be a verified SES identity. |
| `NESSIE_EMAIL_INBOUND_S3_BUCKET` | yes | Bucket the receipt rule writes raw MIME to. |
| `NESSIE_EMAIL_SNS_TOPIC_ARN` | yes | The one topic. Notifications from any other topic are refused even when correctly signed. |
| `NESSIE_EMAIL_SES_ACCESS_KEY_ID` / `NESSIE_EMAIL_SES_SECRET_ACCESS_KEY` | no | Static credentials. Omit both to use the SDK default chain (instance profile / IRSA). |
| `NESSIE_EMAIL_INBOUND_S3_PREFIX` | no | Key prefix, matching `ObjectKeyPrefix` above. |
| `NESSIE_EMAIL_CONFIGURATION_SET` | no (recommended) | Stamped on every send; its event destination is what delivers bounces and complaints. |
| `NESSIE_EMAIL_INBOUND_RETENTION_DAYS` | no | How long raw MIME stays in the bucket after import. Default `30`; `0` keeps it forever. |
| `NESSIE_EMAIL_CUSTOM_DOMAINS` | no | `true` lets org owners verify their own domains through this SES account. Default `false` — every tenant domain shares this account's reputation. |
| `NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR` | no | Per-mailbox outbound cap. Default `30`; overflow parks as approvals rather than being dropped. |
| `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES` | no | Inbound size ceiling, checked with `HeadObject` before the body is streamed. Default 25 MiB. |

## Verifying

```bash
# The API knows it is configured (owner session; a member sees only `available`).
curl -s -H "Authorization: Bearer $TOKEN" https://api.nessie.works/api/agent-email/config

# The inbound route is reachable and refuses an unsigned body — a 403, never a 200.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.nessie.works/api/integrations/email/inbound -d '{}'
```

Then give an agent an address from its **Email** tab, send it a message from a
real mailbox, and watch the conversation appear at
`/agents/:agentId/mailbox`. Worker logs `[worker.agent-email] disabled` when the
configuration is incomplete.

## Operating notes

* **Reputation is per SES account, so the suppression list is deployment-wide.**
  A permanent bounce or a complaint suppresses that recipient for *every*
  organisation on this deployment; `email_send` then refuses with
  `RECIPIENT_SUPPRESSED`. Watch the SES reputation dashboard.
* **An ambiguous send is never retried.** If the worker dies between SES
  accepting a message and recording that it did, the message shows
  `delivery_unknown` in the mailbox and stays there — a retry would be a second
  copy in the recipient's inbox, which is not recoverable.
* **Deleting a mailbox retires its address permanently.** The row is kept and
  the unique index keeps the local part off the market, so a recycled name can
  never inherit an old correspondent's trust.
* **What an agent may send is three gates, not one**: the `email_send` tool must
  be granted to that agent on the Tools page, the mailbox's send policy decides
  whether a person approves each message, and a run that read anything its
  recipient cannot reach always parks an approval naming those sources.

