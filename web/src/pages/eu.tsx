// Where Nessie is built, where it runs, and what it holds. This page describes
// architecture and choices that are true in the source today. It deliberately
// makes no compliance claim, and where a fact could not be established from the
// repository it shows a dashed gap rather than a reassuring sentence.
import { Link } from 'react-router-dom'

export const EuPage = () => (
  <>
    <h2>Who builds it, and under what law</h2>
    <p>
      Nessie is built by <strong>UnlikeOtherAI s.r.o.</strong>, a company registered in the{' '}
      <strong>Czech Republic</strong> and operating under Czech law. The copyright notice on the source
      reads “Copyright 2026 UnlikeOtherAI”.
    </p>
    <p>
      This page is a description of how the software is built and where it runs. It is not a compliance
      statement: Nessie holds no security certification, and nothing here should be read as one. What
      personal data is processed and on what basis is the subject of the{' '}
      <Link to="/privacy">privacy policy</Link>, which is a separate page.
    </p>

    <h2>Where the hosted product runs</h2>
    <p>
      Nessie Cloud runs on <strong>Hetzner</strong>, inside the EU — the region is Germany or France. The
      hosted product may move to a French provider later.
    </p>
    <p className="n-placeholder">
      Anything more precise than that — a specific site, city or datacentre — is deliberately not stated
      here, because it would go out of date without anyone noticing.
    </p>

    <h2>Self-hosting puts the choice in your hands</h2>
    <p>
      Nessie is designed to be run by the organisation using it. Self-hosting is free, including for
      commercial and internal business use by an organisation of any size — run it for your own people
      without paying for a licence or asking permission.
    </p>
    <p>
      The licence is the Functional Source License, Version 1.1, with an Apache 2.0 future licence
      (FSL-1.1-ALv2). It names four permitted purposes: your own internal use and access, non-commercial
      education, non-commercial research, and professional services you provide to someone else running
      Nessie. The one thing it excludes is a competing use — taking the software and offering it as a
      commercial product or service that substitutes for it. Each release converts to the Apache License
      2.0 automatically, two years after that release is published.
    </p>
    <p>
      <strong>Where a self-hosted instance runs is a deployment setting, not a product setting.</strong>{' '}
      The single-machine path is a Docker Compose stack you place on a machine you choose. In the
      Terraform tree for a managed cloud, the region is an input with no default at all: nothing there
      can be guessed, so nothing there has a default, and the database, the object-storage bucket and the
      services all follow the region you name.
    </p>
    <p>
      Two structural details matter for the same question. The queue and the realtime transport are both
      PostgreSQL — there is no Redis and no message broker in the path, so there is no third system to
      place. And object storage is S3-compatible rather than tied to one vendor; the reference deployment
      runs MinIO in a container on a private network with no ingress of its own. The parts that have to
      live somewhere are the database, the object store and the two Node services, and they all live
      wherever you put them. How to stand that up is on the{' '}
      <Link to="/docs/installation">installation page</Link>.
    </p>

    <h2>What Nessie holds — and what it deliberately does not</h2>

    <h3>Identity is not copied</h3>
    <p>
      Where a deployment uses UnlikeOtherAI (UOA) for sign-in, <strong>UOA is the sole authority and the
      durable store for human identity</strong> — authentication factors, profiles, organisation and team
      membership, and invitations. Nessie is a relying party, not a second identity system. This is a data
      decision as much as an architectural one: an identity Nessie never stores is one it cannot leak,
      lose or fail to delete.
    </p>
    <p>
      What the <code>users</code> table actually keeps is the stable UOA subject — the key everything else
      resolves through — the email address, a <em>non-authoritative</em> display-name and avatar mirror,
      and product-local fields (preferences, pronouns, a token version used to revoke sessions). The
      mirror exists only so a name and a picture can be rendered without a request per row, and it is
      re-synced from the provider’s verified claims at login, at team switch and at session refresh.
      Nothing manufactures a value: a person the provider has not named carries their email address until
      it does. A password hash exists only for the bootstrap owner of an install with no identity
      provider at all.
    </p>
    <p>
      The same holds for structure. One UOA organisation is one Nessie organisation, bound by UOA’s own
      organisation id; a team with no upstream link answers <code>404 TEAM_NOT_LINKED</code> rather than
      falling back to a local guess, and a live roster read goes to UOA and persists nothing.
    </p>
    <p>
      <strong>Two mirrors have not gone yet, and it would be dishonest to imply otherwise.</strong>{' '}
      Organisation and team <em>names</em> are still stored locally alongside the binding ids, and local
      membership rows still authorise ordinary requests between synchronisations. Removing both is tracked,
      open work in the repository rather than something already finished.
    </p>

    <h3>Nothing commercial</h3>
    <p>
      Billing is UOA’s, not Nessie’s. Nessie stores no payment-provider customer, subscription, invoice,
      price, credit balance, top-up policy, payment consent, statement or cancellation state, and it does
      not calculate tariffs. It reads display-ready values and shows them.
    </p>

    <h3>Secrets</h3>
    <p>
      <strong>A configured vault is required to store a secret at all.</strong> There is deliberately no
      database fallback and no plaintext path: without one, saving, rotating and revoking a secret return
      an error rather than degrading to something less safe. Nessie’s own records for a secret hold no
      value, no ciphertext, no key and no vault token — only an opaque reference and its metadata — and
      vault paths are built from structural identifiers only, never from an organisation, team, project
      or person’s name.
    </p>
    <p>
      Credentials Nessie must hold itself to act as an OAuth client — connector and mailbox credentials,
      webhook secrets, session refresh material, executor payloads — are sealed in purpose-bound
      AES-256-GCM envelopes under a versioned key ring that is a separate root from the session signing
      secret, with a documented rotation procedure.
    </p>
    <p>
      There is also a rule about models: a secret may be known to exist and may be authorised for use, but
      secret material must not enter model context, prompts, tool arguments, tool results, memory,
      embeddings, search, logs or messages. An agent can be granted the ability to <em>use</em> a secret.
      It can never be granted the ability to reveal one.
    </p>
    <p className="n-placeholder">
      Whether the underlying disks are encrypted is a property of the machine a deployment runs on. The
      repository does not establish volume-level encryption for the database and object-storage volumes,
      so this page does not claim it.
    </p>

    <h2>Tenant isolation</h2>
    <p>
      Nessie is multi-tenant by design: one database, in which every row belongs to exactly one
      organisation and every child table carries an <code>organization_id</code>. Isolation is enforced in
      two places — the scope clause every query carries, and real foreign keys on that column, which were
      added across forty-two constraints after an internal audit found the column present but
      unconstrained on dozens of tables.
    </p>
    <p>
      A conformance suite holds that invariant in place at the HTTP boundary. It seeds a{' '}
      <em>maximally privileged</em> attacker — a full owner of their own organisation — and asserts that
      every canonical read of another organisation’s resources answers 403, 404 or empty, and every
      canonical mutation is rejected with the other organisation’s row untouched. It covers channels,
      approvals, the audit log, triggers, agents and their bindings, runs, projects, tasks, threads,
      connections, workflow installations, MCP instances, the knowledge base and alerts.
    </p>
    <p>
      Being precise about the mechanism: <strong>this is application-level enforcement plus foreign keys,
      not PostgreSQL row-level security.</strong> There is no RLS policy and no database-side backstop, and
      the conformance suite runs against a faithful in-memory store rather than a live database, so it
      proves the scope clauses the code writes rather than the SQL a server executes. The repository says
      so in the suite’s own documentation, and so does this page.
    </p>

    <h2>The audit trail</h2>
    <p>
      Every consequential action is recorded: who acted and as what — a person, an agent, a service — what
      they did, to which resource, in which organisation, project, team or channel, whether it succeeded
      or was denied, why, and the request id, address and user agent it arrived with.
    </p>
    <p>
      The log is append-only by design and there is no way to write to it from outside:{' '}
      <code>POST /api/audit-log</code> does not exist, and that is deliberate. Entries are chained — each
      one carries a SHA-256 digest of its own canonical fields plus the digest of the previous entry for
      that organisation — so a modified or removed row breaks the chain and is detectable. An organisation
      owner can walk that chain on demand and is told where it first broke, if it did.
    </p>
    <p>
      Two honest qualifications. The chain makes the log <em>tamper-evident</em>, not immune to tampering:
      there is no database-level write revocation or write-once storage behind it, so the guarantee is
      detection rather than prevention. And entries are retained indefinitely by default — configurable
      retention with export-before-delete is designed, not built. Entries are also barred from carrying
      secrets or full request bodies, and a fixed set of sensitive metadata field names is redacted on the
      way in.
    </p>

    <h2>The cost ledger</h2>
    <p>
      Every model invocation is recorded against the organisation, and against the user, team, project,
      channel, agent and run it came from, with the tokens it consumed and both the provider-reported cost
      and Nessie’s own estimate kept side by side. A metric a provider does not report is stored as null
      rather than guessed. Reports are readable by an organisation owner.
    </p>
    <p>
      This ledger is operational telemetry — what an organisation spent and on whose behalf. It is not an
      invoice and not a billing authority.
    </p>

    <h2>Third parties, when you use the hosted product</h2>
    <p>
      A hosted deployment talks to a small, fixed set of services. Model traffic and web search do not go
      to providers directly: both leave through one gateway operated by UnlikeOtherAI, which is where the
      upstream model and search providers sit. Sign-in and billing go to UnlikeOtherAI’s authenticator.
      The secret vault is self-hosted alongside the application. Server-minted video-call links default to
      the public Jitsi service.
    </p>
    <p>
      Almost everything else is off until an operator configures it, and says so rather than failing
      quietly: connected Google, Microsoft and Slack accounts; agent email over Amazon SES, which a
      deployment runs in its own account with no intermediary; mobile and browser push; research and
      board-source connectors; cloud browsers. Two details are worth stating because they change where
      data goes:
    </p>
    <ul>
      <li>
        <strong>Connected mailboxes stay with your provider.</strong> Mail is read over your own IMAP or
        SMTP server; Nessie stores the password, sealed, and nothing else about the account.
      </li>
      <li>
        <strong>Voice calls do not pass through Nessie.</strong> The API brokers a credential and the
        client opens the audio connection itself, so the audio never reaches a Nessie server.
      </li>
    </ul>
    <p>
      One inference detail follows the same principle: signed caller-identity headers are only sent to the
      configured chat host, so pointing embeddings at a different endpoint never hands that endpoint a
      delegation assertion about the person whose text is being embedded.
    </p>
    <p className="n-placeholder">
      Which model the hosted product runs on by default, and what the provider of that model does with the
      traffic it receives — including whether it may be used for training — is not stated on this page
      until it can be stated accurately and kept accurate. It is a deployment setting, and a self-hosted
      instance chooses it for itself.
    </p>

    <h2>Running it yourself changes all of this</h2>
    <p>
      Every third party above is a configuration choice on a self-hosted instance. Inference can be
      pointed at any OpenAI-compatible endpoint, including one on your own hardware. The connectors are
      off unless you turn them on. Sign-in through UOA is the supported path, and a deployment with no
      identity provider at all runs as a single unbound organisation with a bootstrap owner.
    </p>
    <p>
      That is the whole point of the arrangement: the software is the same, and the decisions about where
      it runs and what it may reach belong to whoever runs it. The{' '}
      <Link to="/docs/installation">installation page</Link> covers how.
    </p>
  </>
)
