# Local deterministic mail-agent workflow

`pnpm --filter @nessie/worker test:e2e:mail-agent` deterministically exercises
one realistic connected-mail workflow: a scripted inference response receives
a natural-language request, searches and reads a seeded client email, proposes a reply, waits for
the mailbox owner's pinned approval, and delivers exactly one message through
TLS SMTP. The recipient mailbox is read through TLS IMAP to prove delivery.

The command starts an isolated GreenMail fixture on loopback high ports and
generates a short-lived certificate for `mail.nessie.test`. Its child process
sets `NODE_EXTRA_CA_CERTS` to that certificate and uses Node's test-module mock
to map only that exact synthetic hostname to `127.0.0.1`; every other hostname
uses Nessie's ordinary vetted resolver. TLS hostname verification stays on, and
there is no application configuration or production dialer exception for local
addresses. Set `NESSIE_MAIL_E2E_MODE=real` to use local Ollama
(`gemma4:latest`) instead; that opt-in probe incurs no cloud cost.
The command removes only its namespaced fixture and generated certificate after
the probe; it leaves the separate local wire-health server untouched.

Before running it, install workspace dependencies and create a dedicated,
migrated Postgres database. Export its URL as `DATABASE_URL`; the harness passes
that exact value to both database configuration variables. Docker must be
available for GreenMail. For example, run the repository's normal Prisma
migration command against the dedicated database, then:

```sh
DATABASE_URL=postgresql://... pnpm --filter @nessie/worker test:e2e:mail-agent
```

The default uses scripted inference only for model decisions; SMTP/IMAP,
connection lifecycle, agent access, approval/resume, and delivery are real.
It verifies a different effective user and a revoked agent grant are denied,
that no send action exists before approval, and that recipient, subject, and
body observed over IMAP match the frozen approval arguments.
The Ollama mode is an opt-in realistic-work probe because its tool selection is
nondeterministic. Browser connected-mail tests remain
fixture contracts and are not evidence of this SMTP/IMAP worker flow.
