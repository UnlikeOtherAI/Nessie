# Local real-model mail-agent probe

`pnpm --filter @nessie/worker test:e2e:mail-agent` exercises one realistic
connected-mail workflow: a local Gemma model receives a natural-language
request, searches and reads a seeded client email, proposes a reply, waits for
the mailbox owner's pinned approval, and delivers exactly one message through
TLS SMTP. The recipient mailbox is read through TLS IMAP to prove delivery.

The command starts an isolated GreenMail fixture on loopback high ports and
generates a short-lived certificate for `mail.nessie.test`. Its child process
sets `NODE_EXTRA_CA_CERTS` to that certificate and uses Node's test-module mock
to map only that exact synthetic hostname to `127.0.0.1`; every other hostname
uses Nessie's ordinary vetted resolver. TLS hostname verification stays on, and
there is no application configuration or production dialer exception for local
addresses. The model is local Ollama (`gemma4:latest`) and incurs no cloud cost.
The command removes only its namespaced fixture and generated certificate after
the probe; it leaves the separate local wire-health server untouched.

This is an opt-in realistic-work probe rather than CI coverage: model tool
selection is intentionally nondeterministic. Browser connected-mail tests remain
fixture contracts and are not evidence of this SMTP/IMAP worker flow.
