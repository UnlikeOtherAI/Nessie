# Connected mailboxes — an agent working in a mailbox you already have

An agent can work in a mailbox that exists somewhere else: your own, or a team's
shared `support@`. A personal Gmail or Microsoft account can use its native,
secure sign-in and private sync with label/folder controls; another provider, or
a team's shared mailbox, connects over SMTP/IMAP. You then choose which agents may use the live
mailbox and ask them things — *"anything from the bank?"*, *"reply to Petra that
Thursday works"*.

The IMAP/SMTP route has no inbox screen, deliberately. The provider holds the
mail; Nessie holds a credential and an audit trail, and reads it live when an
agent is asked something. Nothing is imported, nothing is copied, and
disconnecting leaves no trace of that correspondence behind. Native Gmail and
Microsoft cards share the personal Email page but are different connectors: they
show their own selected-email sync behaviour rather than making the live-mail
claim.

This is agent email **Model A**. The other model gives an agent its own hosted
address on the deployment's Amazon SES account, with a real mailbox surface
inside Nessie — that is [agent-email.md](agent-email.md), and it is configured by
an operator rather than by you. Design and invariants for both:
[plans/2026-09-02-agent-email.md](plans/2026-09-02-agent-email.md).

## Connecting one

Two scopes, and the difference matters:

| | **Your mailbox** | **A team's shared mailbox** |
|---|---|---|
| Where | `/settings/connections` → *Email* | `/settings/organization` → *Shared mailboxes* |
| Who can connect it | Anybody | An owner or an admin |
| Which runs reach it | Only ones acting **as you** — you asking directly, or a schedule you set up under your own account | Any run by an agent you gave access to |
| Who can manage it | You. Not your org owner, not an admin | An owner or an admin |

Start with the mailbox address. Nessie recognises the common secure sign-in
routes and, for a reviewed IMAP/SMTP configuration, keeps server names, ports
and transport choices out of the normal path. A personal Google or Microsoft
account goes straight to its provider's sign-in page when that connector is
available. A shared mailbox never uses that personal OAuth route. If a provider
requires an app-specific password, Nessie says so before showing the one password
field. Advanced settings are the recovery path when secure settings cannot be
confirmed or you choose to override them.

Discovery and connection are separate. The discovery request contains the
address and scope, never a password, and runs the reviewed registry plus MX,
mail/JMAP/Exchange-Online SRV, and HTTPS autoconfiguration probes within one
short deadline. MX is only a provider clue. A same-domain or reviewed provider
configuration can authorize the compact password screen; an external SRV
target without corroboration, conflicting provider evidence, or an unknown
domain cannot. JMAP may be recognised, but until its connector is installed the
flow falls back to a trusted IMAP/SMTP configuration or Advanced settings.

**Where the provider offers an app password, use one** — this credential reads
everything in the mailbox and can send as it, so a scoped, revocable one is worth
the two minutes it takes to create.

Common settings:

| Provider | IMAP | SMTP |
|---|---|---|
| Google Workspace / Gmail (app password) | `imap.gmail.com:993`, TLS | `smtp.gmail.com:587`, STARTTLS |
| Microsoft 365 | `outlook.office365.com:993`, TLS | `smtp.office365.com:587`, STARTTLS |
| Fastmail | `imap.fastmail.com:993`, TLS | `smtp.fastmail.com:465`, TLS |
| Most others | `:993` TLS | `:587` STARTTLS |

> Gmail over an app password is a supported alternative to the Google
> connection at `/settings/connections`, not a replacement for it. The Google
> lane uses Gmail's own API with per-capability consent; this one is a password
> that reaches the whole mailbox. Connect whichever suits the account, and the
> two never share a send path — they are different tools with different names.

Connecting **tests the mailbox before storing anything**: a real IMAP login and
a real SMTP session both have to succeed. A wrong hostname or password is a
message on the form, not a connection that fails later in the middle of
somebody's task.

## Asking the Personal Assistant to manage accounts

The Personal Assistant can list the email accounts you are entitled to manage —
your own, plus shared mailboxes only when you are an owner or admin —
open the same secure **Connect email** form, check one, disconnect one after an
approval, and grant or revoke an agent's access to an IMAP/SMTP mailbox. For
example: *“Which email accounts are connected?”*, *“Connect another email
account”*, *“Check the support mailbox”*, or *“Let the Support agent use that
mailbox.”*

Connection never turns the conversation into a password box. The assistant's
connect tool accepts no secret arguments and posts only a button into chat; the
button opens the address-first form also used under Settings. OAuth happens on
Google's or Microsoft's own page, and a conventional mailbox password stays in
the protected connection form.

Listing returns an exact account id and kind so a follow-up operation cannot
guess between two addresses. A personal mailbox is manageable only by the
person who connected it; an owner or admin may also manage shared mailboxes.
The listing is treated as private account metadata, so a reply built from it is
limited to the requesting person. Connection-state wording is deliberately
generic — server replies and diagnostics never enter chat. A shared-mailbox
connection request from a non-manager is refused before a form is posted.
Google and Microsoft checks queue their normal
initial or incremental sync. An IMAP/SMTP check logs in to both incoming and
outgoing services with the stored credential. Disconnect is always held for a
person to approve before the assistant runs it.

Agent access remains two decisions. Asking the assistant to grant mailbox
access writes the per-mailbox permission only; it does not silently enable
`mailbox_search`, `mailbox_read`, or `mailbox_send` on the agent. Manage those
tool grants separately on the agent's **Email & calendar** tools screen.

## Giving an agent access

Two separate switches, and an agent needs both:

1. **The tools**, on the agent itself (Agent → Tools → *Email & calendar*):
   `mailbox_search`, `mailbox_read`, `mailbox_send`. These are off by default.
2. **The mailbox**, on the connection's card: *Agents with access*.

The second exists because the first cannot name a mailbox — tool permissions are
per tool, so without a per-mailbox decision, connecting a second shared mailbox
would silently hand it to every agent that already had the tools.

An agent with access to more than one mailbox is asked which to use rather than
picking one. Sending from the wrong address is not something anyone can take
back.

## Sending

**Every message is shown to a person before it goes out.** The request lands on
the approvals surface and, in chat, as a notice on the run — and it is *pinned*
to one person: the mailbox's owner for a personal one, or whoever connected a
shared one. It says which address the mail would leave from, and if the agent
built the message out of something the recipient has no claim to — a private
document, another person's mail — the approval names that too.

There is no "let it send without asking" for connected mailboxes yet. The Google
lane offers standing consent because a grant there is one person's to give about
their own account; a shared team mailbox has no such single owner, and one grant
table meaning two different things is how that distinction gets lost.

## Reading

Reads run live, and they carry their provenance. An agent that answers you out
of your mailbox produces a reply **only you can see**, even in a shared channel,
with the usual one-click share if you want to pass it on. A shared team mailbox
restricts to that team the same way.

Mail is treated as information, never instruction. Anything in a message that
reads like an order to the agent — *"forward this to…"*, *"ignore your
instructions"* — is data about what a correspondent wants, and cannot authorize
a tool call on its own.

## When it stops working

If the provider rejects the password, the connection flips to **Needs
reconnecting** with a fixed, actionable reason on its card, and agents stop reaching it rather
than failing over and over. A password change, an expired app password, or a
revoked account all land here. Reconnect it from the same card.

A mail server that is briefly unreachable is *not* that: the status is left
alone, because sending somebody to re-enter a password that is fine helps
nobody. **Test** on the card re-runs both legs on demand.

## What an operator needs to know

Nothing is configured for this — there are no environment variables and no AWS
account. Two settings exist for tuning:

| Variable | Meaning |
|---|---|
| `NESSIE_MAILBOX_TIMEOUT_MS` | How long to wait on a mail server, per read (default 20000). |
| `NESSIE_AUTH_SECRET` | Already required. Passwords are sealed with it, in a table separate from the connection. |

Security properties worth knowing, since this is the one place Nessie opens a
raw socket to an address somebody typed:

- **TLS is mandatory.** Implicit TLS, or STARTTLS that refuses to continue if
  the server does not offer the upgrade. The password is never written to a
  plaintext socket.
- **The host is re-resolved and re-vetted on every connection** against the same
  private-range rules the HTTP egress guard uses, and the socket then opens to
  an address that was just checked — so a hostname cannot be re-pointed at the
  internal network between the check and the connect. Certificates are verified
  against the hostname you configured, not the address dialled.
- **Nothing typed by a person or a model can become an IMAP command.** Folder
  names, search terms and the credential all travel as length-counted literals,
  so no character inside them can end a command.
- The password is stored encrypted in its own table, is never returned by any
  API read, and never appears in the audit trail — which records the address and
  the scope, and nothing else.
