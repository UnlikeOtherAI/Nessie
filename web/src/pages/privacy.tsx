// The prose of /privacy. The title, the lede, the route and every link to this
// page come from `registry.ts`; this file starts at <h2>.
//
// Every claim here is checkable in this repository — the identity mirror, the
// audit trail, the token ledger, the vaults, the cookie bar. Where a fact would
// have to be invented (registration numbers, retention periods, the full
// sub-processor list) it is an `n-placeholder` instead: a visible dashed gap is
// honest, and boilerplate is not.
export const PrivacyPage = () => (
  <>
    <p>
      <strong>This is a draft.</strong> It describes what the software actually does today, but it has not been
      reviewed by a lawyer and Nessie has not launched. Some of what a finished policy needs is marked below as
      missing rather than guessed at.
    </p>

    <h2>1. Self-hosted or Nessie Cloud — this matters first</h2>
    <p>
      Nessie comes in two forms, and they are completely different for privacy. Work out which one you are
      reading about before you read anything else.
    </p>
    <ul>
      <li>
        <strong>Self-hosted.</strong> You run Nessie on your own infrastructure. Your organisation is the
        controller of everything in it. UnlikeOtherAI has no access to your instance, receives nothing from it,
        and processes no personal data on your behalf. This policy describes the software’s behaviour so you can
        write your own; it does not make us a processor for you.
      </li>
      <li>
        <strong>Nessie Cloud.</strong> We run it. For the personal data your organisation puts into it we act as
        a <strong>processor</strong>, on your instructions; your organisation is the controller. For the small
        amount of data we handle in our own right — account administration, billing, support correspondence, this
        website — we are the controller. The rest of this policy is about Nessie Cloud.
      </li>
    </ul>
    <p>
      One caveat on the self-hosted case. Nessie is software that talks to other services, so your instance will
      reach out to whatever you configure it to reach: a model provider, a mail provider, a search or browser
      service. Those are your relationships, and they are outside our control and outside this policy.
    </p>

    <h2>2. Who we are</h2>
    <p>
      <strong>UnlikeOtherAI s.r.o.</strong>, a company registered in the Czech Republic. Contact us about
      anything on this page at <a href="mailto:hello@nessie.works">hello@nessie.works</a>.
    </p>
    <p className="n-placeholder">
      Missing: the company registration number (IČO) and the registered office address.
    </p>
    <p className="n-placeholder">
      Missing: whether a data protection officer has been appointed, and their contact details if so. Nobody is
      named as DPO today.
    </p>
    <p className="n-placeholder">
      Missing: the effective date of this policy.
    </p>

    <h2>3. What personal data we process, and where it comes from</h2>

    <h3>Identity, which comes from UnlikeOtherAI SSO</h3>
    <p>
      Nessie Cloud has no passwords and no sign-up form. You sign in through <strong>UnlikeOtherAI SSO</strong>,
      which is the authority for who you are, which organisation you belong to and which teams you are in. Nessie
      does not create accounts, does not let you set a password, and refuses a request to change your profile
      picture because your picture lives in UnlikeOtherAI. Your name, your email address and your profile are
      changed there.
    </p>
    <p>
      <strong>Nessie does keep a copy of some of it, and we would rather say so than claim otherwise.</strong> Its
      database holds your stable UnlikeOtherAI subject identifier, and beside it a cached mirror of your email
      address, display name and picture URL, so a hundred rows of chat can render a name without a hundred
      lookups. That mirror is explicitly non-authoritative: nothing invents a value, nothing writes your changes
      back to it, and it is re-synced from the identity provider’s verified claims every time you sign in, switch
      team or refresh your session. Your organisation’s live roster is read from UnlikeOtherAI at the time it is
      shown, through short-lived caches that are never allowed to decide who may see what. Removing the mirrored
      columns altogether is planned work, not something already done.
    </p>
    <p>
      We also keep, durably: your organisation’s and teams’ UnlikeOtherAI identifiers, your membership and role
      inside them, and an encrypted UnlikeOtherAI refresh credential plus local session records, so you can stay
      signed in and so a sign-out can revoke every outstanding token at once.
    </p>

    <h3>What you and your colleagues put into Nessie</h3>
    <p>
      Messages, threads and direct messages; files and attachments; knowledge-base documents; tasks, projects and
      channels; agent names, roles and instructions; your status and preferences. Any of this can contain personal
      data about you, your colleagues, or third parties such as your customers — that is entirely up to what your
      organisation writes.
    </p>

    <h3>Data your agents encounter while working</h3>
    <p>This is the part that deserves the most attention, because an agent reaches further than a chat app.</p>
    <ul>
      <li>
        <strong>Connected mailboxes.</strong> If someone connects a mailbox — their own, or a team’s shared
        address — an agent can read and reply to it. Mail from a connected account is read <em>live</em> from your
        provider: Nessie holds the credential and an audit record, does not import the messages, and leaves no
        copied correspondence behind when you disconnect. But while an agent works on a message, that message’s
        content is in Nessie and is sent to a model. Everyone who writes to that mailbox is affected by this, and
        they never agreed to it.
      </li>
      <li>
        <strong>Hosted agent mailboxes.</strong> A deployment can instead give an agent its own address. Mail to
        that address <em>is</em> stored in Nessie: the message is parsed, its attachments are stored, and the raw
        original is deleted from the inbound bucket after a configurable period (30 days unless the operator
        changes it).
      </li>
      <li>
        <strong>The web, and browsers.</strong> Agents can fetch pages, run searches and drive a real browser
        session. A person can lend an agent a private browser scoped to named sites for at most fifteen minutes.
        Nessie also keeps a small screenshot of each tab an agent’s browser was left on, so the product can show
        it — which means those images can contain the content of a signed-in page.
      </li>
      <li>
        <strong>Connected tools.</strong> MCP servers, calendars and other integrations you connect return data
        into the agent’s context, and that data goes to the model with everything else.
      </li>
    </ul>

    <h3>Records Nessie keeps about what happened</h3>
    <ul>
      <li>
        <strong>An audit trail.</strong> Every control-plane action is recorded with who did it (person, agent or
        service), what they did, to what, whether it succeeded or was refused and why, a request id, and — when
        available — the IP address and browser user-agent. It is append-only and linked into a per-organisation
        hash chain, so tampering is detectable. Secrets, credentials and full request bodies are deliberately kept
        out of it.
      </li>
      <li>
        <strong>A token-cost ledger.</strong> Every model call is recorded with the provider, the model, token
        counts and an estimated cost, attributed to an organisation, team, project, channel, agent and person.
      </li>
      <li>
        <strong>Storage accounting</strong>, so per-organisation and per-person storage use is always known.
      </li>
      <li>
        <strong>Session and device records</strong>: hashed session and refresh tokens, expiry, client type and
        user-agent, and — if you use the mobile or desktop apps — a push token.
      </li>
    </ul>

    <h3>Data derived from your content</h3>
    <p>
      To let agents recall things and to make search work, Nessie turns text into numeric vectors (embeddings) and
      stores them in its database. This covers agent memory, knowledge-base content and <em>your search queries
      themselves</em>. Producing a vector means sending the text to an embedding provider. If no embedding
      provider is configured, recall and search fall back to plain keyword matching.
    </p>

    <h3>This website</h3>
    <p>
      Almost nothing. See section 9 — there is no analytics tool loaded on nessie.works today.
    </p>

    <h2>4. Why we process it, and on what lawful basis</h2>
    <table>
      <thead>
        <tr>
          <th>Why</th>
          <th>Basis</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Running Nessie Cloud for your organisation — storing and delivering content, running agents</td>
          <td>Performance of our contract with your organisation. We act on its instructions.</td>
        </tr>
        <tr>
          <td>Signing you in and keeping you signed in</td>
          <td>Performance of the contract.</td>
        </tr>
        <tr>
          <td>The audit trail, approval gates and tenant isolation</td>
          <td>Our legitimate interest, and your organisation’s, in a secure and accountable service.</td>
        </tr>
        <tr>
          <td>The token and storage ledgers, and billing</td>
          <td>Performance of the contract, and our legal obligation to keep accounting records.</td>
        </tr>
        <tr>
          <td>Support you ask us for</td>
          <td>Performance of the contract, or our legitimate interest in answering you.</td>
        </tr>
        <tr>
          <td>Analytics cookies on this website</td>
          <td>Your consent, which you give or refuse in the cookie bar and can change at any time.</td>
        </tr>
      </tbody>
    </table>
    <p>
      Where your organisation is the controller, the lawful basis for putting a particular person’s data into
      Nessie — a customer’s email, for instance — is your organisation’s to establish, not ours.
    </p>
    <p>
      <strong>We do not sell personal data</strong>, and we do not use your content to advertise to you.
    </p>

    <h2>5. Who else sees it</h2>

    <h3>Model providers — the important one</h3>
    <p>
      When an agent runs, the content of the conversation goes to a language model. That means the messages, the
      relevant files, the mail it is working on and the results of the tools it called leave Nessie and reach the
      model provider your deployment is configured with. There is no way to run an agent without this happening.
    </p>
    <p>
      Which provider that is depends on configuration. Nessie can talk to a small, fixed set of providers named in
      its code, or to any OpenAI-compatible endpoint an operator names, and individual people can connect their
      own AI subscriptions so their agents run on an account they already pay for. In Nessie Cloud, calls are
      routed through a gateway operated by UnlikeOtherAI, which passes them to the upstream provider along with
      signed information identifying the organisation, team, person, agent and run the call came from. Web search
      and deep research go through the same gateway.
    </p>
    <p>
      <strong>Some model tiers are cheaper because the upstream provider is allowed to train on the traffic.</strong>{' '}
      This is a real trade-off that the choice of model makes, and it applies to customer content. The
      configuration shipped in this repository today selects such a tier for the hosted product. We are flagging
      it rather than burying it, because nobody should discover it by reading a config file.
    </p>
    <p className="n-placeholder">
      Missing, and required before launch: exactly which model and tier Nessie Cloud runs by default, whether the
      upstream provider may use that traffic for training, and how a customer opts out or chooses a tier that is
      not training-eligible.
    </p>

    <h3>Other people we rely on</h3>
    <ul>
      <li><strong>Hosting</strong> — Hetzner, in Germany or France. See section 6.</li>
      <li>
        <strong>Identity</strong> — UnlikeOtherAI SSO, which holds your account, profile and organisation
        membership.
      </li>
      <li>
        <strong>Payments</strong> — your subscription and statement are handled by UnlikeOtherAI, and card
        payments are processed by Stripe. Nessie itself stores no card details, subscription or invoice.
      </li>
      <li>
        <strong>The services a feature needs.</strong> Hosted agent mailboxes send and receive through Amazon SES.
        Cloud browser sessions run on a third-party browser provider. Voice calls to your assistant open a direct
        audio connection between your device and Google. Meeting links are minted with the provider your
        organisation chose — Google Meet, Jitsi or Microsoft Teams. Mobile notifications go through Apple and
        Google’s push services, carrying an internal reference rather than message content.
      </li>
      <li>
        <strong>Anything you connect yourself</strong> — your mail provider, your MCP servers, your own AI
        accounts. Those are your relationships and your providers’ policies apply.
      </li>
    </ul>
    <p className="n-placeholder">
      Missing: a proper sub-processor list — every processor by legal name, what it does, where it processes data,
      and a way to be told before we add one. The list above is what can be read out of the source code, not a
      maintained register.
    </p>
    <p>
      We also disclose personal data where the law requires it, and to professional advisers under a duty of
      confidence.
    </p>

    <h2>6. Where your data is, and transfers out of the EU</h2>
    <p>
      Nessie Cloud runs on <strong>Hetzner</strong> infrastructure in <strong>Germany or France</strong>. Both are
      in the EU. We may move to another EU provider later.
    </p>
    <p>
      Your content does not stay inside that boundary in one important case: when an agent runs, the request goes
      to a model provider, and that provider may process it outside the EU. The same is true of search, of browser
      sessions, of voice calls, and of anything you connect yourself. Self-hosting puts the storage under your
      control but does not by itself change this — the model call still leaves your building.
    </p>
    <p className="n-placeholder">
      Missing: the transfer mechanism relied on for each non-EU processor — standard contractual clauses, an
      adequacy decision, or something else — and the transfer impact assessment behind it.
    </p>

    <h2>7. How long we keep it</h2>
    <p>
      Honestly: <strong>Nessie has no automatic retention or deletion schedule.</strong> Content stays until
      somebody deletes it. The audit trail is deliberately append-only and is not deleted at all today, because
      the whole point of a tamper-evident log is that entries cannot quietly disappear. There is no self-service
      data export and no self-service organisation deletion in the product; when you ask us to export or erase,
      we do it by hand.
    </p>
    <p>The exceptions we can point to in the code:</p>
    <ul>
      <li>
        Raw inbound email for hosted agent mailboxes is deleted from the storage bucket after a configurable
        period, 30 days by default, once the message has been imported.
      </li>
      <li>A temporary private browser grant expires after at most fifteen minutes.</li>
      <li>
        Identity caches are held in memory only and expire in seconds or minutes; they are never a durable store.
      </li>
      <li>Disconnecting a connected mailbox leaves no copied correspondence behind, because none was kept.</li>
    </ul>
    <p className="n-placeholder">
      Missing: actual retention periods for content, audit entries, ledger entries, session records and backups,
      and a period after an account or organisation closes. We will not publish numbers the software does not
      enforce.
    </p>

    <h2>8. How it is protected</h2>
    <p>Concretely, and only things that exist in the code:</p>
    <ul>
      <li>
        <strong>Secrets never sit in the database in the clear.</strong> Customer secrets go to a dedicated vault;
        with no vault configured Nessie refuses to save one rather than falling back to plaintext. Personal AI
        subscription credentials go to a second, separate vault, so an identity scoped to one cannot read the
        other. Refresh credentials, connector tokens and push keys are stored as AES-256-GCM envelopes under a
        versioned key ring that can be rotated.
      </li>
      <li>
        <strong>Secret material is kept away from models.</strong> An agent may know a secret exists and be
        allowed to use it, but the value must never enter a prompt, a tool argument, a tool result, memory,
        embeddings, logs or a notification. An agent can never be granted permission to reveal one.
      </li>
      <li>
        <strong>A scanner refuses messages containing credentials</strong> both in the composer and again at the
        server, and can retroactively scrub a credential already posted — including from the agent memory taken
        from that message.
      </li>
      <li>
        <strong>The audit trail is tamper-evident</strong>, chained per organisation with SHA-256 and verifiable
        after the fact.
      </li>
      <li>
        <strong>Agents only see what they were given</strong>, and what an agent read constrains who may read its
        answer, so material from a private source cannot be laundered into a public room.
      </li>
      <li>
        <strong>Outbound requests are IP-pinned</strong>, re-validated on every redirect, so a model- or
        user-supplied address cannot be redirected at internal infrastructure.
      </li>
      <li>
        <strong>Location metadata is stripped from uploaded photos</strong> (EXIF and GPS) at the single point
        where files are stored, unless an organisation turns that off.
      </li>
      <li>Everything is encrypted in transit, and access is scoped by role at organisation, team and project level.</li>
    </ul>
    <p>
      No security is perfect. If you find a problem, please tell us at{' '}
      <a href="mailto:hello@nessie.works">hello@nessie.works</a>.
    </p>
    <p className="n-placeholder">
      Missing: whether backups are encrypted and where they are held, and our breach notification commitment —
      how quickly we tell a customer after we become aware of a personal data breach.
    </p>

    <h2>9. Cookies and this website</h2>
    <p>This is the whole of it:</p>
    <ul>
      <li>
        <strong>Your cookie choice</strong> is stored in your browser’s local storage under{' '}
        <code>nessie-cookie-consent</code>. It never leaves your browser.
      </li>
      <li>
        <strong>A preference cookie</strong>, <code>nessie-device-colour</code>, remembers which colour you picked
        for the computer on the homepage. It is first-party, lasts a year, and contains a colour name.
      </li>
      <li>
        <strong>Analytics are off unless you switch them on.</strong> The bar offers the choice, we remember your
        answer, and refusing costs you nothing.
      </li>
    </ul>
    <p>
      <strong>There is no analytics tool on this website at the moment</strong> — no tracking script, no
      advertising pixel, no third-party tag of any kind. The consent control exists so that the answer is already
      recorded if we ever add one. You can reopen the bar and change your mind from the cookie link in the footer.
    </p>
    <p className="n-placeholder">
      Missing: which analytics tool we intend to use, what it stores and for how long. This section must be
      updated on the day one is added.
    </p>
    <p>
      Signing in to the product sets cookies and stores tokens that are strictly necessary to keep you signed in.
      They are not optional, and they are not used for tracking.
    </p>

    <h2>10. Your rights</h2>
    <p>If the GDPR applies to you, you can ask us to:</p>
    <ul>
      <li><strong>tell you</strong> what personal data we hold about you, and give you a copy;</li>
      <li><strong>correct</strong> anything that is wrong;</li>
      <li><strong>delete</strong> it;</li>
      <li>
        <strong>restrict</strong> or <strong>object to</strong> how we use it, including anything we do on the
        basis of legitimate interests;
      </li>
      <li><strong>port</strong> it to another service in a machine-readable form;</li>
      <li><strong>withdraw consent</strong> where we relied on it, which for us means analytics cookies.</li>
    </ul>
    <p>
      Write to <a href="mailto:hello@nessie.works">hello@nessie.works</a>. We will respond within one month.
    </p>
    <p>
      Two honest caveats. First, if your organisation uses Nessie Cloud, your organisation is the controller of
      what is inside it — so for your messages and files we will normally pass your request to them and act on
      their instruction. Ask them directly and you will get an answer faster. Second, your account itself lives in
      UnlikeOtherAI SSO, so a request about your name, email address or profile is really a request to that
      service; we will point you there.
    </p>
    <p>
      Nessie does not make automated decisions with legal or similarly significant effects about you. Agents
      produce drafts, suggestions and actions; what an agent may do without a person approving it is a setting
      your organisation controls.
    </p>
    <p>
      You can also complain to a data protection supervisory authority — in the Czech Republic, the Office for
      Personal Data Protection, or the authority in the EU country where you live or work. We would rather you
      came to us first.
    </p>

    <h2>11. Children</h2>
    <p>
      Nessie is a tool for organisations and is not meant for children. We do not knowingly process the personal
      data of anyone under 16 through it, and we do not aim any part of it at children. If you believe a child’s
      data has ended up in Nessie Cloud, tell us and we will remove it.
    </p>

    <h2>12. Changes to this policy</h2>
    <p>
      We will update this page as the product changes — and it will change, because several sections above say
      plainly that something is missing. When a change materially affects you, we will say so rather than quietly
      editing the page, and the updated version will carry its date.
    </p>
    <p className="n-placeholder">
      Missing: how we notify customers of a material change, and whether earlier versions of this policy will stay
      available.
    </p>

    <h2>13. Contact</h2>
    <p>
      <a href="mailto:hello@nessie.works">hello@nessie.works</a>, for privacy questions, rights requests and
      anything else on this page.
    </p>
    <p className="n-placeholder">
      Missing: an EU representative under Article 27, if one is required and appointed. None is appointed today.
    </p>
  </>
)
