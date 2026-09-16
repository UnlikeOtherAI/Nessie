// The public API documentation page. The title, the lede, the route and every
// link to it come from `registry.ts`; this file is the prose only.
export const ApiPage = () => (
  <>
    <h2>What the API is</h2>
    <p>
      Nessie has one HTTP API. The admin web app, the macOS and iOS clients and the
      remote executor daemon are all ordinary clients of it, and nothing they can do is
      reachable any other way. It is a JSON API over a Fastify server, it is not
      GraphQL, and it has no separate &ldquo;public&rdquo; subset: the surface your own
      scripts call is the surface the product calls.
    </p>
    <p>
      There is no version segment in the path. Every route lives under{' '}
      <code>/api</code>, except the inbound MCP endpoint at <code>POST /mcp</code> and a
      handful of <code>/.well-known/</code> discovery documents. Compatibility is
      managed by only ever adding fields, so a client that ignores what it does not
      recognise keeps working.
    </p>

    <h2>Base URL</h2>
    <p>
      Nessie is self-hosted, so the base URL is whatever origin your deployment serves
      the API on — the operator sets it as <code>NESSIE_API_PUBLIC_URL</code>, and the
      same value is what the API uses when it has to mint an absolute URL of its own.
      On the instance we run, that is <code>https://api.nessie.works</code>; a
      development instance started with <code>pnpm dev</code> answers on{' '}
      <code>http://localhost:5454</code>.
    </p>
    <p>
      The admin web app is a different origin from the API, so browser clients are
      subject to a CORS allowlist (<code>NESSIE_CORS_ORIGINS</code>). Requests from a
      script or a server have no origin to check and are unaffected.
    </p>

    <h2>Authenticating</h2>
    <p>
      Every request outside a small set of deliberately public routes carries an access
      token in the standard header:
    </p>
    <pre><code>{`Authorization: Bearer <token>`}</code></pre>
    <p>
      The token is a signed JWT minted by the API. It is short-lived — thirty minutes by
      default (<code>NESSIE_AUTH_TOKEN_TTL</code>) — and it is the only credential an
      ordinary caller ever presents. <strong>Nessie has no long-lived personal API
      keys.</strong> If you want a script to call the API, it signs in the same way a
      person&rsquo;s browser does and renews its token as it goes.
    </p>

    <h3>Getting a token</h3>
    <p>
      <code>POST /api/auth/session</code> mints a session. It answers with the access
      token and the caller&rsquo;s identity, and sets the renewal token as a separate
      HTTP-only cookie.
    </p>
    <p>
      How you prove who you are depends on how the instance is deployed. An instance
      running in <code>local</code> mode accepts an email and password. On a{' '}
      <code>hosted</code> or <code>selfHosted</code> instance password sign-in is
      refused outright with <code>403 PASSWORD_AUTH_DISABLED</code>, and the only way in
      is the configured identity provider — so the account can never grow a second,
      weaker identity path beside it.
    </p>

    <h3>Signing in through an identity provider</h3>
    <p>
      Single sign-on is an OAuth authorisation-code exchange with PKCE, in three steps.
      Nessie&rsquo;s own identity provider is UnlikeOtherAI, which also owns the
      organisation and team structure an instance mirrors; the exchange below is the
      same shape for any configured provider.
    </p>
    <ol>
      <li>
        <code>GET /api/auth/providers</code> lists what this instance accepts, each with
        a <code>providerId</code>, a label and whether the sign-in page should redirect
        to it automatically.
      </li>
      <li>
        <code>GET /api/auth/providers/:providerId/authorize</code>, with{' '}
        <code>codeChallenge</code>, <code>redirectUri</code> and <code>state</code> as
        query parameters, answers with <code>{'{ data: { authorizeUrl } }'}</code>. Send
        the person there.
      </li>
      <li>
        The provider returns them to your <code>redirectUri</code> with a code. Post
        that back as <code>POST /api/auth/session</code> with{' '}
        <code>{'{ providerId, code, codeVerifier, redirectUri }'}</code> — all four are
        required together, and an incomplete set is a{' '}
        <code>400 EXTERNAL_AUTH_INCOMPLETE</code>.
      </li>
    </ol>

    <h3>Renewing a session</h3>
    <p>
      The renewal token is never in a response body. It is set as an HTTP-only cookie
      named <code>nessie_refresh</code>, scoped to the <code>/api/auth</code> path, with
      a thirty-day lifetime by default (<code>NESSIE_AUTH_REFRESH_TOKEN_TTL</code>).
      Calling <code>POST /api/auth/refresh</code> with that cookie consumes it, issues a
      fresh access token and sets a new cookie in its place — the tokens rotate, so a
      stolen one is good only until the real client next refreshes.
    </p>
    <p>
      A command-line client therefore needs a cookie jar. With <code>curl</code> that is{' '}
      <code>--cookie-jar</code> on the sign-in call and <code>--cookie</code> on the
      refresh, as in the worked example below.
    </p>

    <h3>What is checked on every request</h3>
    <p>
      Authentication is not only a signature check. Before a handler runs, the API
      verifies the token&rsquo;s signature and expiry, confirms the session has not been
      revoked (both by the user-wide token version and by the individual session id),
      and loads the caller&rsquo;s membership of the organisation the token names. A
      deactivated membership is a <code>403</code>. When the organisation is backed by
      an external identity provider, the caller&rsquo;s current standing is re-checked
      against that provider on the request rather than read from the token, so access
      removed upstream stops working immediately instead of at the next expiry.
    </p>

    <h3>Credentials that are not session tokens</h3>
    <p>
      Two other bearer credentials exist, and neither is a general-purpose key. A voice
      device credential is accepted only on the voice call routes; an agent access
      credential is accepted only on the MCP endpoint. Presenting either anywhere else
      is refused with a <code>403</code> naming the credential, not retried as a weaker
      session — see <a href="/docs/mcp">MCP and connected tools</a> for how the agent
      credential is issued.
    </p>

    <h2>The response envelope</h2>
    <p>
      Every successful response is an object with a <code>data</code> key. There is no
      bare array and no top-level payload at the root, so a client never has to
      discriminate on shape:
    </p>
    <pre><code>{`{
  "data": { "id": "3f1c…", "label": "engineering" }
}`}</code></pre>
    <p>
      List endpoints add a <code>meta</code> object beside it. Nothing else is ever
      added at the top level.
    </p>
    <p>Failures use one shape too, whatever produced them:</p>
    <pre><code>{`{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A message needs content or at least one attachment",
    "field": "body",
    "details": { "formErrors": [], "fieldErrors": {} }
  }
}`}</code></pre>
    <p>
      <code>code</code> is the machine-readable part and is what you should branch on;{' '}
      <code>message</code> is for a person. <code>field</code> and <code>details</code>{' '}
      are present when the failure is specific enough to locate. An unhandled server
      error is always <code>500 INTERNAL_ERROR</code> with a fixed message — the
      underlying error text is logged, never returned, because it can have picked up
      request data on its way out.
    </p>

    <h3>Error codes you will meet first</h3>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Code</th>
          <th>Meaning</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>400</td>
          <td><code>VALIDATION_ERROR</code></td>
          <td>The body or query did not match the schema.</td>
        </tr>
        <tr>
          <td>401</td>
          <td><code>AUTH_REQUIRED</code></td>
          <td>No bearer token, or the header was malformed.</td>
        </tr>
        <tr>
          <td>401</td>
          <td><code>TOKEN_EXPIRED</code></td>
          <td>The access token is past its expiry. Refresh and retry.</td>
        </tr>
        <tr>
          <td>401</td>
          <td><code>TOKEN_REVOKED</code></td>
          <td>The session was signed out, or every session was forced out.</td>
        </tr>
        <tr>
          <td>403</td>
          <td><code>ACCOUNT_DEACTIVATED</code></td>
          <td>The membership of this organisation has been deactivated.</td>
        </tr>
        <tr>
          <td>404</td>
          <td><code>NOT_FOUND</code></td>
          <td>No such route, or no such record visible to this caller.</td>
        </tr>
        <tr>
          <td>429</td>
          <td><code>RATE_LIMITED</code></td>
          <td>A bucket is full. Read <code>Retry-After</code>.</td>
        </tr>
        <tr>
          <td>500</td>
          <td><code>INTERNAL_ERROR</code></td>
          <td>An unhandled server error, deliberately opaque.</td>
        </tr>
      </tbody>
    </table>

    <h2>Pagination</h2>
    <p>
      List endpoints page with an opaque keyset cursor, not an offset — rows are
      inserted while somebody reads, and with an offset the second page silently repeats
      a record the first page already showed.
    </p>
    <p>
      Three query parameters are accepted: <code>cursor</code>, <code>limit</code> and{' '}
      <code>direction</code> (<code>forward</code> or <code>backward</code>). The
      default page is 25 and the ceiling is 100; a larger value is clamped rather than
      rejected. Endpoints that also sort or filter add <code>sort</code>,{' '}
      <code>order</code> and a free-text <code>q</code>.
    </p>
    <p>The page&rsquo;s <code>meta</code> tells you where you are:</p>
    <pre><code>{`{
  "data": [ … ],
  "meta": {
    "hasMore": true,
    "nextCursor": "2026-09-12T08:31:44.005Z|8b2f…",
    "prevCursor": null,
    "total": 134
  }
}`}</code></pre>
    <p>
      <code>nextCursor</code> and <code>prevCursor</code> are both real: Previous and
      Next are both controls a person expects. They are opaque — the server encodes its
      own sort key into them, and a client that parses or constructs one will break the
      moment a list changes how it orders. <code>total</code> is present on most lists
      and omitted where counting is not meaningful, such as ranked search results.
    </p>

    <h2>Rate limits</h2>
    <p>
      Limits are per fixed window and are enforced before the request body is even read.
      A rejected request is <code>429</code> with the code <code>RATE_LIMITED</code> and
      a <code>Retry-After</code> header in seconds.
    </p>
    <p>
      Most buckets are keyed on the client IP; the credential-sensitive ones — sign-in,
      refresh, password re-proof, MCP credential writes — keep a per-account counter as
      well and reject when <em>either</em> trips, so one address spraying many accounts
      and one account attacked from many addresses both run into a wall. Sign-in
      defaults to 10 attempts per IP and 5 per email address per ten minutes; posting a
      message defaults to 60 per minute; writes under <code>/api/agents</code> to 60 per
      minute. Every threshold is configurable per deployment, so treat these as the
      shipped defaults rather than a contract. Health checks and the realtime streams
      are exempt.
    </p>

    <h2>Realtime</h2>
    <p>
      Polling a list is the wrong way to follow a conversation. Three streaming
      endpoints exist instead:
    </p>
    <ul>
      <li>
        <code>GET /api/events/stream</code> — server-sent events for everything the
        signed-in person can see.
      </li>
      <li>
        <code>GET /api/threads/:threadId/stream</code> — server-sent events for one
        thread. It honours <code>Last-Event-ID</code>, so a reconnect resumes rather
        than restarts.
      </li>
      <li>
        <code>GET /api/activity</code> — a WebSocket carrying the activity feed.
      </li>
    </ul>
    <p>
      Browsers cannot set headers on a WebSocket handshake, so the WebSocket route also
      accepts the access token as a <code>?token=</code> query parameter. That is the
      only place a token belongs in a URL; every other route takes the header.
    </p>

    <h2>The resource families</h2>
    <p>
      There are around 665 endpoints across 95 route modules, which is far too many to
      list. They group into families, and once you know a family&rsquo;s prefix the
      individual routes are predictable — a collection at the prefix, a record beneath
      it, and named actions as <code>POST</code> sub-paths.
    </p>
    <table>
      <thead>
        <tr>
          <th>Family</th>
          <th>Prefix</th>
          <th>What it covers</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Auth</td>
          <td><code>/api/auth</code></td>
          <td>Sign-in, renewal, sign-out, the current identity, a person&rsquo;s own sessions.</td>
        </tr>
        <tr>
          <td>Channels and threads</td>
          <td><code>/api/channels</code>, <code>/api/threads</code></td>
          <td>The conversation model: channels hold threads, threads hold messages, replies nest under a root.</td>
        </tr>
        <tr>
          <td>Agents</td>
          <td><code>/api/agents</code></td>
          <td>Agent definitions, their channel bindings, conversations, to-dos and status.</td>
        </tr>
        <tr>
          <td>Projects and boards</td>
          <td><code>/api/projects</code>, <code>/api/tasks</code>, <code>/api/iterations</code></td>
          <td>Work tracking: boards and columns under a project, tasks on them, iterations over those.</td>
        </tr>
        <tr>
          <td>Knowledge</td>
          <td><code>/api/knowledge-base</code></td>
          <td>Spaces of versioned pages and files, with comments, backlinks and search.</td>
        </tr>
        <tr>
          <td>Mail</td>
          <td><code>/api/mail</code>, <code>/api/mailbox-connections</code></td>
          <td>Connected mailboxes, agent mailboxes, and drafts an agent wrote for a person to approve.</td>
        </tr>
        <tr>
          <td>Approvals</td>
          <td><code>/api/approvals</code></td>
          <td>The queue of actions an agent may not take unilaterally, and the one call that resolves them.</td>
        </tr>
        <tr>
          <td>Audit</td>
          <td><code>/api/audit-log</code></td>
          <td>The organisation&rsquo;s hash-chained audit trail, with a verification endpoint. Owner only.</td>
        </tr>
        <tr>
          <td>Cost and usage</td>
          <td><code>/api/ledger</code>, <code>/api/billing</code></td>
          <td>Token and cost accounting, budgets and run timings; separately, credits and top-ups. Owner only.</td>
        </tr>
        <tr>
          <td>Organisation and teams</td>
          <td><code>/api/organizations</code>, <code>/api/teams</code>, <code>/api/users</code></td>
          <td>Tenant, team and membership administration, including invitations.</td>
        </tr>
        <tr>
          <td>Triggers</td>
          <td><code>/api/triggers</code></td>
          <td>Schedules and webhooks that start agent work, with their firing history.</td>
        </tr>
        <tr>
          <td>Calls and voice</td>
          <td><code>/api/calls</code>, <code>/api/voice</code></td>
          <td>In-channel calling, and the voice assistant&rsquo;s session, transcript and device tokens.</td>
        </tr>
        <tr>
          <td>Executors</td>
          <td><code>/api/executors</code>, <code>/api/execution-environment-templates</code></td>
          <td>The machines agents work on, their environments, and the daemon pairing channel.</td>
        </tr>
        <tr>
          <td>Runs</td>
          <td><code>/api/runs</code></td>
          <td>Live agent runs: cancel, continue, restart, bind to an executor.</td>
        </tr>
        <tr>
          <td>Uploads</td>
          <td><code>/api/uploads</code>, <code>/api/attachments</code></td>
          <td>Upload a file first, then link the returned id to a message.</td>
        </tr>
        <tr>
          <td>Search</td>
          <td><code>/api/messages/search</code></td>
          <td>Message search, organisation-wide or scoped to one channel.</td>
        </tr>
        <tr>
          <td>Secrets and settings</td>
          <td><code>/api/secrets</code>, <code>/api/settings/scoped</code></td>
          <td>Write-only credential storage with explicit grants, and layered configuration values.</td>
        </tr>
        <tr>
          <td>Connected tools</td>
          <td><code>/api/mcp</code></td>
          <td>MCP servers this instance calls out to. See <a href="/docs/mcp">MCP and connected tools</a>.</td>
        </tr>
        <tr>
          <td>Health</td>
          <td><code>/api/health</code></td>
          <td>Liveness and readiness, both public. <code>/api/health/ready</code> also checks the database.</td>
        </tr>
      </tbody>
    </table>
    <p>
      Rights are enforced per route, not per family. Broadly: the audit log, the cost
      ledger, policy rules and the inference control plane are organisation-owner
      surfaces, while conversations, projects, knowledge and approvals are open to any
      member and narrowed by what that member can actually see.
    </p>

    <h2>Worked examples</h2>

    <h3>Sign in and keep the renewal cookie</h3>
    <p>
      On a <code>local</code>-mode instance, with a password. The access token comes
      back in the body; the renewal token lands in the cookie jar.
    </p>
    <pre><code>{`curl -sS https://api.example.com/api/auth/session \\
  --cookie-jar nessie.cookies \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"ada@example.com","password":"…"}'`}</code></pre>
    <pre><code>{`{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "me": {
      "user": {
        "id": "1d4e…",
        "email": "ada@example.com",
        "displayName": "Ada Lovelace",
        "roleIds": ["owner"],
        "superAdmin": false
      },
      "session": {
        "sessionId": "9c07…",
        "issuedAt": "2026-09-16T09:00:00.000Z",
        "expiresAt": "2026-09-16T09:30:00.000Z"
      },
      "context": {
        "organizationId": "5a81…",
        "projectId": "7b12…",
        "teamId": "2e60…",
        "channelId": null,
        "bootstrapMode": false
      },
      "auth": {
        "providerId": "local",
        "providerType": "local-bootstrap",
        "autoRedirectToSso": false
      }
    }
  }
}`}</code></pre>
    <p>When the token expires, exchange the cookie for a new one:</p>
    <pre><code>{`curl -sS -X POST https://api.example.com/api/auth/refresh \\
  --cookie nessie.cookies --cookie-jar nessie.cookies`}</code></pre>
    <p>
      The response is the same <code>{'{ token, me }'}</code> shape, and the cookie jar
      now holds the rotated renewal token.
    </p>

    <h3>List the channels you can see</h3>
    <pre><code>{`curl -sS https://api.example.com/api/channels \\
  -H "Authorization: Bearer $TOKEN"`}</code></pre>
    <pre><code>{`{
  "data": [
    {
      "id": "8b2f…",
      "label": "engineering",
      "type": "standard",
      "visibility": "public",
      "projectId": "…",
      "projectName": "Platform",
      "teamId": "…",
      "defaultThreadId": "c41a…",
      "unreadCount": 3,
      "lastMessageAt": "2026-09-15T18:22:07.441Z",
      "viewerCanManage": true
    }
  ]
}`}</code></pre>
    <p>
      Add <code>?teamId=…</code> to narrow to one team, or{' '}
      <code>?includeArchived=true</code> to include archived channels. The{' '}
      <code>defaultThreadId</code> is what you post to next.
    </p>

    <h3>Post a message</h3>
    <p>
      A message needs either some <code>content</code> or at least one uploaded
      attachment. Send an <code>Idempotency-Key</code> and a retried request resolves to
      the message the first attempt created rather than posting a second copy.
    </p>
    <pre><code>{`curl -sS https://api.example.com/api/threads/c41a…/messages \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: 0f9c2d16-8f4a-4c1e-9a77-6b0d4f2e1a53' \\
  -d '{"content":"Deploying the migration now."}'`}</code></pre>
    <p>A new message is <code>201</code>:</p>
    <pre><code>{`{
  "data": {
    "message": {
      "id": "d70e…",
      "threadId": "c41a…",
      "role": "user",
      "content": "Deploying the migration now.",
      "createdAt": "2026-09-16T09:04:11.882Z"
    },
    "pendingAgentInvites": []
  }
}`}</code></pre>
    <p>
      A replay of the same idempotency key answers <code>200</code> with the original
      message and an empty <code>pendingAgentInvites</code>, because the first attempt
      already did the alerting and dispatch that the array describes.
    </p>
    <p>
      Two refusals on this route are worth handling explicitly. Content past the chat
      length limit is <code>413 MESSAGE_TOO_LARGE</code>, and the right response is to
      upload the text as a file instead. Content that structurally looks like a
      credential is <code>422 SECRET_INTERCEPTED</code> — the server refuses before the
      message is stored, dispatched or logged, and the credential belongs in{' '}
      <code>/api/secrets</code>.
    </p>
  </>
)
