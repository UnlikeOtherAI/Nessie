// The MCP documentation page. The title, the lede, the route and every link to
// it come from `registry.ts`; this file is the prose only.
export const McpPage = () => (
  <>
    <h2>What MCP is</h2>
    <p>
      The Model Context Protocol is a small, open convention for describing tools to a
      language model and calling them. A server declares what it can do — a list of
      named tools, each with a JSON schema for its arguments — and a client discovers
      that list and invokes them on the model&rsquo;s behalf. It is deliberately dull:
      the value is that one integration written once works with every model and every
      product that speaks it.
    </p>

    <h2>Nessie sits on both sides of it</h2>
    <p>
      That is worth being precise about, because the two halves are easy to confuse and
      they live at deliberately different paths.
    </p>
    <ul>
      <li>
        <strong>Outbound.</strong> Nessie is an MCP <em>client</em>. You connect servers
        somebody else runs, and the tools they expose become tools your agents can use.
        The management surface is <code>/api/mcp/*</code>.
      </li>
      <li>
        <strong>Inbound.</strong> Nessie is also an MCP <em>server</em>. An agent
        running somewhere else — Claude Code or Codex on a developer&rsquo;s machine —
        can call into your boards and documents. That endpoint is{' '}
        <code>POST /mcp</code>, outside <code>/api</code> on purpose, so the two opposite
        meanings are not one path segment apart.
      </li>
    </ul>

    <hr />

    <h2>Connecting an MCP server to Nessie</h2>

    <h3>Catalogue entries and instances</h3>
    <p>There are two objects, and the distinction matters:</p>
    <ul>
      <li>
        A <strong>catalogue entry</strong> is the definition of a server — its name, its
        transport, how it authenticates. It is written once and can be shared.
      </li>
      <li>
        An <strong>instance</strong> is that entry installed at one scope, with the
        credentials that reach it. Installing the same entry for two different teams
        produces two instances.
      </li>
    </ul>
    <p>
      Most people never touch either directly. The doorway in the admin is the app store
      at <code>/apps</code>: it browses the same catalogue with the connection details
      hidden, and <code>Connect</code> on a listing creates an instance. Operators who
      want the raw objects use <code>/api/mcp/catalog</code> and{' '}
      <code>/api/mcp/instances</code>.
    </p>
    <p>
      If a server is not in the catalogue yet, <code>POST /api/mcp/discover</code> takes
      a URL and reads back what the server says about itself, and{' '}
      <code>POST /api/mcp/library/import</code> pulls an entry from the public server
      library. A first-run connection can also be created straight from a URL with{' '}
      <code>POST /api/apps/custom</code>.
    </p>

    <h3>Transports</h3>
    <p>
      Nessie connects to remote servers over HTTP. Two transports work: streamable HTTP
      (the current MCP transport) and the older HTTP+SSE transport. Pick{' '}
      <code>http</code> unless the server only offers <code>sse</code>.
    </p>
    <p>
      <strong>The <code>stdio</code> transport is refused for connectors you author.</strong>{' '}
      stdio means the MCP server is a local process the host starts, and running
      arbitrary programs inside the Nessie server is not something an operator can
      meaningfully review. Servers that are published only as a package to run locally
      are dropped from library imports for the same reason. A{' '}
      <code>ws</code> value exists in the protocol field and is not implemented — a
      connection using it fails when Nessie tries to open it.
    </p>

    <h3>How Nessie authenticates to the server</h3>
    <p>
      A catalogue entry declares one of five methods: <code>none</code>,{' '}
      <code>api_key</code>, <code>bearer</code>, <code>basic</code> or{' '}
      <code>oauth2</code>.
    </p>
    <p>
      <code>api_key</code> is header injection, and the entry says which header and what
      prefix — so <code>Authorization: Bearer …</code>,{' '}
      <code>X-API-Key: …</code> and <code>X-Auth-Token: Token …</code> are all the same
      method configured differently. The key itself is pasted once with{' '}
      <code>POST /api/mcp/instances/:instanceId/secret</code> and is never readable
      again; no response from the instance routes carries a credential reference.
    </p>
    <p>
      <code>oauth2</code> comes in two shapes. A server with fixed endpoints has them in
      its catalogue entry. A server that publishes standard metadata needs nothing
      configured at all: Nessie reads the protected-resource and authorization-server
      documents, and mints itself a client through dynamic client registration or
      through the client-ID metadata document it publishes at its own well-known path.
      Either way the handshake is <code>POST /api/mcp/instances/:instanceId/oauth/start</code>{' '}
      followed by the provider&rsquo;s redirect back to{' '}
      <code>GET /api/mcp/oauth/callback</code>. The state token is single-use, held in
      the database and valid for ten minutes, and PKCE is always used.
    </p>
    <p>
      One rule surprises people: even an organisation owner cannot attach a personal or
      OAuth token to somebody else. A shared credential is only possible for an
      API-key entry that has been validated as one; anything else is refused. A
      credential that belongs to a person stays a credential that belongs to that
      person.
    </p>

    <h3>Where the credentials live</h3>
    <p>
      Connector secrets and OAuth token bundles are stored in your own Postgres
      database, in purpose-bound AES-256-GCM envelopes under the deployment&rsquo;s
      independently versioned encryption key ring, and addressed only by opaque{' '}
      <code>secret_*</code> references. They are deliberately <em>not</em> in the
      external secret vault that holds other Nessie secrets. A production deployment
      that has not configured the encrypted store refuses to start rather than complete
      an OAuth handshake it would then drop on the floor.
    </p>

    <h3>Where a connection reaches</h3>
    <p>
      An instance is installed at one of six scopes: <code>system</code>,{' '}
      <code>organization</code>, <code>project</code>, <code>team</code>,{' '}
      <code>channel</code> or <code>user</code>. That scope is a hard ceiling on which
      runs can use it, and grants can only narrow it further, never widen it — so a
      connector you installed with your own account cannot quietly become an
      organisation-wide one.
    </p>
    <p>
      Who may install where follows the same shape: an owner manages installs at any
      scope; an admin manages the shared scopes and their own; everyone else installs
      connectors at their own <code>user</code> scope, and can see shared installs they
      are entitled to reach.
    </p>

    <h3>Giving an agent a tool</h3>
    <p>
      Connecting a server does not hand its tools to anybody. When an instance is
      installed, Nessie probes it and projects each tool it advertises into the tool
      registry, which is what the admin shows at <code>/agents/tools</code> — built-in
      tools, MCP tools, bundle tools and executor tools in one list, each with its
      source and status.
    </p>
    <p>
      A projected tool has one of three statuses: <code>active</code>,{' '}
      <code>pending_review</code> or <code>disabled</code>. Tools from a shared-scope
      install arrive as <code>pending_review</code> and have to be approved on that page
      before an agent sees them; tools from your own <code>user</code>-scope install are
      active straight away, because the only person exposed is you. Review is recurring,
      not a one-off ceremony: if a later probe finds that a tool&rsquo;s description or
      schema has drifted, it goes back to <code>pending_review</code> and stops being
      offered until somebody looks at the change.
    </p>
    <p>Which agents may then call an active tool is decided one of two ways:</p>
    <ul>
      <li>
        A connection created through the app store <strong>requires an explicit
        grant</strong>. An agent gets the tool only when a grant names it, and the grant
        is checked against the tool&rsquo;s current fingerprint, so a changed tool needs
        a fresh decision.
      </li>
      <li>
        Otherwise the tool is on by default for the agents in reach of its scope, and
        individual agents are switched off on the tool&rsquo;s detail panel.
      </li>
    </ul>
    <p>
      A grant names exactly one principal — a role or an agent, never both — and a deny
      beats an allow. For a <code>user</code>-scope connection the question does not
      arise: any agent that person talks to can use it, and an explicit switch-off is
      the only thing that withholds it.
    </p>
    <p>
      One thing that is easy to look for in the wrong place:{' '}
      <code>/settings/connections</code> in the admin is <em>connected accounts</em> —
      Slack, mailboxes, model subscriptions and the OAuth links to Linear, Jira, GitHub
      and Trello that back external boards. MCP connectors are at <code>/apps</code>,
      and the tools they produce are at <code>/agents/tools</code>.
    </p>

    <h3>Approval gates on tool calls</h3>
    <p>
      Some tool calls stop and wait for a person. When one does, the run does not fail:
      the invocation is frozen — the tool name, a hash of its arguments and enough state
      to resume — and an approval request appears in <code>/api/approvals</code> for
      somebody to answer. Resuming is idempotent, so a duplicated approval cannot run
      the call twice. The person deciding sees a bounded summary of what is being asked;
      the exact arguments and the originating run stay server-side.
    </p>
    <p>There are two distinct gates, and they are configured differently.</p>
    <ul>
      <li>
        <strong>Structural gates</strong> are a property of certain built-in tools and
        are not configurable. Sending mail from an agent&rsquo;s own mailbox or from a
        connected one, sending a Gmail draft, disconnecting a mail account, creating,
        changing or cancelling a calendar event, and a browser action that would write
        to a site the browser is not signed in to are all gated this way. They get a
        24-hour window to be answered rather than the usual 30 minutes.
      </li>
      <li>
        <strong>Policy gates</strong> come from policy rules on the{' '}
        <code>tool</code>/<code>invoke</code> pair. A rule that allows an invocation can
        carry <code>requiresApproval</code>, and without a verified approval the
        evaluation returns <code>APPROVAL_REQUIRED</code> rather than running. Rules are
        evaluated deny-first and ordered by scope.
      </li>
    </ul>
    <p className="n-placeholder">
      Which admin screen authors a <code>requiresApproval</code> policy rule for a tool —
      the data model and the enforcement are both in place, but we could not confirm the
      screen that writes such a rule.
    </p>

    <hr />

    <h2>Pairing an outside agent with Nessie</h2>
    <p>
      The other direction. Nessie runs an MCP server of its own at{' '}
      <code>POST /mcp</code>, over streamable HTTP, and it is stateless: every call
      carries its own credential and resolves its own actor, so there is no session to
      pin a client to one replica. An agent running on somebody&rsquo;s laptop can work
      on your boards and documents from inside whatever tool that person already uses.
    </p>

    <h3>What a paired credential actually is</h3>
    <p>
      This is the part to get right, because the obvious mental model — an API key with
      permissions attached — is the wrong one.
    </p>
    <p>
      <strong>A paired credential is never an identity.</strong> It names a human, and
      every tool call runs as that human, against the same service functions the HTTP
      routes call. An agent therefore cannot reach anything the person who lent it could
      not reach by clicking. Scopes only ever narrow that reach; there is no scope that
      widens it.
    </p>
    <p>
      Liveness is re-read on every single call, never trusted from the token: revocation,
      expiry, the user&rsquo;s token version, their organisation membership and their
      current role. A demotion, a deactivation or a &ldquo;sign me out
      everywhere&rdquo; lands on the agent&rsquo;s next call rather than at the
      credential&rsquo;s expiry.
    </p>
    <p>
      The token is opaque, prefixed <code>nag1_</code>, stored only as a SHA-256 hash,
      and lives 90 days. It is refused with a specific <code>403</code> on any route
      other than the MCP endpoint — presenting it elsewhere is not a partial success to
      retry, which is what keeps &ldquo;I lent an agent my boards&rdquo; from meaning
      &ldquo;I lent it my account&rdquo;.
    </p>

    <h3>Pairing</h3>
    <p>
      A command-line agent controls no browser and can host no callback URL, so the
      handshake is the device authorization grant (RFC 8628) rather than a redirect.
    </p>
    <ol>
      <li>
        The agent calls <code>POST /mcp/auth/device</code> with a{' '}
        <code>clientName</code> and the <code>scopes</code> it wants. It gets back a{' '}
        <code>device_code</code>, a short <code>user_code</code>, a{' '}
        <code>verification_uri</code> and a <code>verification_uri_complete</code> with
        the code already in the query, plus the poll <code>interval</code> and an{' '}
        <code>expires_in</code>. It prints the URI.
      </li>
      <li>
        A person opens that URI while signed in to the admin, at{' '}
        <code>/settings/paired-agents</code>. They see which agent is asking, whose
        account it would work as, until when, and exactly what it would be able to do —
        and they choose <strong>Allow</strong> or <strong>Don&rsquo;t allow</strong>.
      </li>
      <li>
        The agent polls <code>POST /mcp/auth/token</code> with the{' '}
        <code>deviceCode</code>, honouring <code>authorization_pending</code>,{' '}
        <code>slow_down</code>, <code>expired_token</code> and{' '}
        <code>access_denied</code>. On success it receives{' '}
        <code>{'{ access_token, token_type, scope, expires_at }'}</code>.
      </li>
    </ol>
    <p>
      There is a human step because the credential inherits a person&rsquo;s
      entitlements, so a person has to choose to lend them. Nothing here mints access
      from nothing. Pairing can also be switched off for a whole organisation at{' '}
      <code>/settings/organization/paired-agents</code>, and that answer is checked when
      somebody allows a pairing, not when an agent starts one — nobody is signed in at
      that point.
    </p>

    <h3>Discovery</h3>
    <p>
      An unauthenticated <code>POST /mcp</code> answers <code>401</code> with a{' '}
      <code>WWW-Authenticate</code> header pointing at{' '}
      <code>/.well-known/oauth-protected-resource</code>, so a client gets something it
      can act on rather than an opaque refusal. That document is RFC 9728, and it says
      plainly that no authorisation server runs here, naming the two device endpoints
      and the scopes this deployment supports instead. Advertising an authorisation
      server that does not exist would fail later and less legibly.
    </p>

    <h3>Scopes and tools</h3>
    <p>
      There are four scopes, and they are coarse on purpose — a scope nobody can explain
      is a scope nobody sets correctly.
    </p>
    <table>
      <thead>
        <tr>
          <th>Scope</th>
          <th>Tools</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>boards_read</code></td>
          <td>
            <code>nessie_board_list</code>, <code>nessie_board_get</code>,{' '}
            <code>nessie_task_get</code>
          </td>
        </tr>
        <tr>
          <td><code>boards_write</code></td>
          <td>
            <code>nessie_task_create</code>, <code>nessie_task_update</code>,{' '}
            <code>nessie_task_move</code>
          </td>
        </tr>
        <tr>
          <td><code>documents_read</code></td>
          <td>
            <code>nessie_space_list</code>, <code>nessie_doc_list</code>,{' '}
            <code>nessie_doc_get</code>
          </td>
        </tr>
        <tr>
          <td><code>documents_write</code></td>
          <td>
            <code>nessie_doc_create</code>, <code>nessie_doc_update</code>,{' '}
            <code>nessie_doc_publish</code>
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      A call without the scope it needs comes back as a tool result naming the scope to
      ask for, not as a transport error, so the model can report something useful
      instead of retrying into a wall.
    </p>
    <p>
      There is no separate family of tools for external trackers. A board is a board
      whether its tasks originate in Nessie or are mirrored from Linear, Jira, GitHub or
      Trello, so one tool set covers both, and every task says which it is. What differs
      is writing: a board mirrored from a read-only source refuses a write in words,
      telling the agent that the other system owns the ticket and that retrying will not
      help.
    </p>

    <h3>Publishing a document is an approval, never a scope</h3>
    <p>
      Agents draft; a person publishes. That rule is enforced for Nessie&rsquo;s own
      agents by refusing an agent actor outright — but a paired credential resolves as a{' '}
      <em>person</em>, so that refusal cannot catch it. The gate has to be somewhere
      else.
    </p>
    <p>
      So <code>nessie_doc_publish</code> does not publish. It opens a{' '}
      <code>knowledge.page.publish</code> approval — the same one a Nessie agent opens —
      and returns <code>{'{ status: "awaiting_approval", approvalId }'}</code>. Polling
      returns the same request rather than opening a second one. The decision is made
      the way every other publication decision in Nessie is made: by a person, about
      that document, at the moment it exists.
    </p>
    <p>
      <strong>There is deliberately no publish scope.</strong> There was one — a tick at
      pairing time saying this agent may publish — and it was retired. It decided, once
      and for ninety days, a question the product asks per document everywhere else, and
      it decided it before the document existed, so the person ticking it could not know
      what they were agreeing to publish. <code>nessie_doc_publish</code> needs{' '}
      <code>documents_write</code>, because asking is not free — it reads the page and
      puts a decision in front of somebody — but that scope grants nothing about
      publication.
    </p>
    <p>
      Two identities are recorded on the request, and the distinction is load-bearing.
      The <strong>requester is the credential</strong>, never the human it acts as. The{' '}
      <strong>required approver is that human</strong>, and only they may answer. If the
      request named the person as its requester, the rule that stops anybody approving
      their own request would disqualify the one person entitled to decide.
    </p>

    <h3>Seeing and revoking what is paired</h3>
    <p>
      A person&rsquo;s own paired agents are listed at{' '}
      <code>/settings/paired-agents</code>, with a label and a revoke control for each.
      An owner or organisation admin sees every credential in the organisation at{' '}
      <code>/settings/organization/paired-agents</code> — what each is called, what it
      may do, whether it is live, and whose account it borrows — and can revoke any of
      them. The personal list stays self-only: a list of live credentials is a list of
      footholds, not general reading.
    </p>
    <p>
      Writes made through a credential are attributed to the borrowing human and carry
      the credential&rsquo;s id in the audit metadata, so the log can tell a
      person&rsquo;s own edit from one their agent made for them.
    </p>

    <h3>What is not available yet</h3>
    <p>
      Being explicit, because the gap between a protocol&rsquo;s capabilities and a
      given server&rsquo;s is where documentation usually lies:
    </p>
    <ul>
      <li>
        Boards and documents are the whole surface. Chat, channels, runs and agent
        management are not exposed over MCP.
      </li>
      <li>
        Semantic document search, board and column administration, and task assignment
        are not in this cut.
      </li>
      <li>
        The device grant is the only way to pair. Full OAuth 2.1 authorisation-code with
        PKCE for browser-based clients is a later step.
      </li>
      <li>
        The pairing switch is an organisation-level setting. Team-level and personal
        overrides are not something a team or a person can set today.
      </li>
    </ul>
  </>
)
