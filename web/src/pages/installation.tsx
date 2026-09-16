// How to run Nessie. Every command, port and environment variable on this page
// is taken from the repository — `docs/deployment/`, `infrastructure/compose/`,
// `infrastructure/terraform/` and the package scripts — rather than written
// from memory. Where the repository does not establish a fact, the page shows a
// dashed gap instead of a guess.
import { Link } from 'react-router-dom'

export const InstallationPage = () => (
  <>
    <h2>What you need before you start</h2>
    <p>
      Nessie is a pnpm monorepo of Node services plus two static bundles. Whichever way you run it,
      the same four things have to exist first.
    </p>
    <ul>
      <li>
        <strong>PostgreSQL with <code>pgvector</code>.</strong> Not optional, and not substitutable —
        the migrations run <code>CREATE EXTENSION vector</code> and create <code>vector(1024)</code>{' '}
        columns. Production runs <code>pgvector/pgvector:pg17</code>.
      </li>
      <li>
        <strong>Node 22 and pnpm.</strong> Every Dockerfile in <code>infrastructure/docker/</code>{' '}
        builds on <code>node:22-slim</code>, and the repository pins its package manager in the root{' '}
        <code>package.json</code> (<code>pnpm@10.22.0</code>).
      </li>
      <li>
        <strong>An OpenAI-compatible model endpoint and a key for it.</strong> Agents and embeddings
        both go through it. See “Configuring inference” below.
      </li>
      <li>
        <strong>S3-compatible object storage</strong>, for any deployment that is not the local
        developer one. Uploads on local disk are refused outside <code>local</code> mode, and that
        refusal is a start-up failure rather than a degraded boot — see “One machine, or a managed
        cloud”.
      </li>
    </ul>
    <p>
      Docker and a reverse proxy are needed for the container path described further down, and a
      domain plus TLS for anything reachable from the internet.
    </p>
    <p className="n-placeholder">
      Hardware sizing — minimum CPU, memory and disk for a given number of people — is not stated
      anywhere in the repository, so this page does not state it either.
    </p>

    <h2>The components, and how they fit together</h2>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>What it is</th>
          <th>Ingress</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>api/</code></td>
          <td>The Fastify HTTP/WebSocket API. Every client talks to this and nothing else.</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>worker/</code></td>
          <td>Agent orchestration and background runs. Polls the job queue; binds no port.</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>admin/</code></td>
          <td>The product interface — a static bundle built by Vite and served by nginx.</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>web/</code></td>
          <td>The public site. Static, optional, and unrelated to running the product.</td>
          <td>Yes</td>
        </tr>
        <tr>
          <td>PostgreSQL</td>
          <td>The database, the job queue and the realtime bus, all three.</td>
          <td>No</td>
        </tr>
        <tr>
          <td>Object storage</td>
          <td>Attachments, avatars and knowledge-base files. S3-compatible; MinIO in production.</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>gateway/</code></td>
          <td>An optional push relay for APNs and FCM. Off unless you enable it deliberately.</td>
          <td>Yes</td>
        </tr>
      </tbody>
    </table>
    <p>
      The API and the worker are <strong>one image</strong>. The two packages are tightly interlinked,
      so <code>Dockerfile.app</code> builds the whole team once and the worker container overrides the
      command to <code>node worker/dist/index.js</code>. In <code>local</code> mode there is no worker
      container at all: the API runs the worker embedded in its own process.
    </p>
    <p>
      <strong>There is no Redis.</strong> The job queue and the realtime transport are both
      Postgres-backed, by decision rather than by omission — the Google Cloud tree deletes its Pub/Sub
      and Redis modules for the same reason.
    </p>

    <h3>Ports</h3>
    <p>
      In local development the API is on <code>5454</code> and the admin on <code>5455</code>. Those two
      are fixed and non-negotiable: other tooling in the repository, including the browser test suites,
      assumes them, and starting either service somewhere else to dodge a conflict breaks that tooling
      rather than working around it.
    </p>
    <p>
      Production is a different matter and is unchanged by that rule. The API container listens
      internally on <code>5554</code> (pinned with <code>NESSIE_API_PORT</code>) and the push relay on{' '}
      <code>5556</code>, both behind the reverse proxy.
    </p>

    <h2>Running it on one machine, for development</h2>
    <p>
      The repository ships a Compose file with just a database in it, which is all the local loop needs.
    </p>
    <pre><code>{`pnpm install
docker compose -f infrastructure/compose/docker-compose.yml up -d postgres`}</code></pre>
    <p>
      That container publishes Postgres on <code>55432</code> with the user, password and database all
      named <code>nessie</code>. Put the connection string in a <code>.env</code> at the repository root —
      the API’s dev script reads it — then apply the migrations and build the worker once, because in
      local mode the API loads the worker from its built <code>dist</code>:
    </p>
    <pre><code>{`DATABASE_URL=postgresql://nessie:nessie@localhost:55432/nessie

pnpm --filter @nessie/api prisma:migrate:deploy
pnpm --filter @nessie/worker build
pnpm dev`}</code></pre>
    <p>
      <code>pnpm dev</code> runs the API and the admin in parallel with hot reload, on 5454 and 5455.
      Check the API answered with <code>GET /api/health</code>.
    </p>

    <h2>Postgres, and the pgvector requirement</h2>
    <p>
      Three extensions are created by the migrations themselves — <code>vector</code>,{' '}
      <code>pg_trgm</code> and <code>pgcrypto</code> — so the role that runs them must be allowed to
      create extensions. On a managed Postgres that is the thing to check before anything else.
    </p>
    <p>
      The vector width is part of the schema, not a setting. <code>thoughts.embedding</code>,{' '}
      <code>thought_recalls.query_embedding</code> and <code>knowledge_page_chunks.embedding</code> are{' '}
      <code>vector(N)</code> columns, and <code>N</code> is stated once as{' '}
      <code>EMBEDDING_DIMENSIONS</code> in <code>packages/schemas/src/embedding.ts</code> — currently
      1024, the native width of the embedding model production uses. Every embed request sends that
      width, so a provider that would answer at another one fails loudly instead of writing vectors the
      database rejects. Moving to an embedding model of a different width means editing that constant,
      writing a migration that re-types the three columns, and re-embedding: vectors of different widths
      are not convertible, so the migration nulls them rather than truncating them.
    </p>
    <p>
      If you run Nessie beside other applications on a shared Docker network, give its database container
      a distinct name. The project’s own Compose service is called <code>nessie-postgres</code> and never{' '}
      <code>postgres</code>, because the service name becomes a DNS alias on the shared network and a
      collision makes <code>postgres:5432</code> round-robin between two databases.
    </p>

    <h2>Configuration</h2>
    <p>
      Runtime configuration is layered: a <code>nessie.config.json</code> file mounted read-only into the
      API and the worker, with environment variables over the top of it. The mapping between the two is{' '}
      <code>ConfigEnvMap</code> in <code>packages/config</code>, which is the authoritative list.
    </p>
    <p>
      <code>NESSIE_MODE</code> picks the deployment shape: <code>local</code> (the default, and the
      developer path), <code>hosted</code>, or <code>selfHosted</code> — which is what a self-hosted
      install sets. It disables dev login and requires a CORS allowlist.
    </p>
    <p>These are the settings a <code>selfHosted</code> deployment will not start, or will not work, without:</p>
    <table>
      <thead>
        <tr>
          <th>Variable</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>DATABASE_URL</code> / <code>NESSIE_DB_URL</code></td>
          <td>The Postgres connection string.</td>
        </tr>
        <tr>
          <td><code>NESSIE_AUTH_SECRET</code></td>
          <td>
            32 bytes of hex (<code>openssl rand -hex 32</code>). Signs sessions and bootstrap tokens.
            Start-up throws without it outside <code>local</code> mode, and it must be the same value on
            every replica and across deploys or every session dies at each release.
          </td>
        </tr>
        <tr>
          <td>
            <code>NESSIE_ENCRYPTION_KEY_RING</code>,{' '}
            <code>NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION</code>
          </td>
          <td>
            A JSON key ring and the label selecting the active root, required outside <code>local</code>{' '}
            mode. This is a <em>separate</em> root from the signing secret — the ring encrypts every
            durable secret Nessie stores. Do not reuse one as the other.
          </td>
        </tr>
        <tr>
          <td><code>NESSIE_STORAGE_PROVIDER</code></td>
          <td>
            Must be <code>s3</code>. <code>filesystem</code> is the default and is refused in{' '}
            <code>hosted</code> and <code>selfHosted</code> mode, so a deployment that sets nothing here
            fails to start rather than writing uploads to a disk no other container can read.
          </td>
        </tr>
        <tr>
          <td><code>NESSIE_CORS_ORIGINS</code></td>
          <td>
            The admin origin. The admin and API are separate origins, and the API must allowlist the one it
            serves.
          </td>
        </tr>
        <tr>
          <td><code>NESSIE_API_PUBLIC_URL</code>, <code>NESSIE_ADMIN_PUBLIC_URL</code></td>
          <td>
            Used to mint OAuth redirect URIs outside an HTTP request. The API throws at request time without
            the first.
          </td>
        </tr>
        <tr>
          <td><code>NESSIE_MODEL_PROVIDER</code>, <code>_BASE_URL</code>, <code>_API_KEY</code></td>
          <td>Where inference goes. See below.</td>
        </tr>
      </tbody>
    </table>
    <p>
      <code>infrastructure/compose/.env.prod.example</code> has the exact shape of all of them, with the
      optional blocks — object storage, secret vault, SSO, connected mail — commented in place. The full
      catalogue, including every optional setting, is <code>docs/deployment/configuration.md</code>.
    </p>

    <h2>Deploying with Docker Compose</h2>
    <p>
      Copy <code>.env.prod.example</code> to <code>.env</code> beside{' '}
      <code>docker-compose.prod.yml</code> and fill it in, then bring the database up, build, migrate and
      start. The order matters: the migrations and the seeds run against a database that is already up,
      before any service is serving.
    </p>
    <pre><code>{`COMPOSE="docker compose -f infrastructure/compose/docker-compose.prod.yml"

bash infrastructure/compose/ensure-encryption-key-ring.sh infrastructure/compose/.env
$COMPOSE up -d nessie-postgres
$COMPOSE build nessie-api nessie-admin nessie-web
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api prisma:migrate:deploy
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api seed:connectors
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api seed:apps
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api reconcile
$COMPOSE up -d`}</code></pre>
    <p>
      The production Dockerfiles run each package’s lint before building it, so a lint failure is a build
      failure.
    </p>

    <h3>The reconcile step is not optional</h3>
    <p>
      <code>reconcile</code> seeds each organisation’s default policy rules and backfills the
      protected-MCP and Personal Assistant tool grants. The API used to do this at boot on every replica;
      it now connects, listens, and does nothing else, so <strong>without this step the first organisation
      has no policy rules and every agent bind is denied</strong>. It is idempotent, so running it on
      every deploy is free — and an upgrade applied by hand has to run it too.
    </p>

    <h2>The first owner account</h2>
    <p>
      A fresh <code>selfHosted</code> install has no users, so the API mints a one-time bootstrap token
      and logs a setup URL. The token lives in Postgres rather than in a process, so every replica agrees
      on it.
    </p>
    <pre><code>{`docker compose -f infrastructure/compose/docker-compose.prod.yml logs nessie-api 2>&1 | grep bootstrap`}</code></pre>
    <p>
      Open <code>https://&lt;your-admin-host&gt;/bootstrap?token=&lt;token&gt;</code> and create the owner
      account. The token expires after 15 minutes; restart the API service to mint a fresh one.
    </p>
    <p>
      <strong>If you configure SSO, there is no bootstrap step at all.</strong> Bootstrap mode is
      suppressed the moment an external auth provider is enabled — otherwise it would hijack the login
      screen — and the first person to sign in through SSO bootstraps the default team and becomes its
      owner.
    </p>

    <h2>Configuring inference</h2>
    <p>
      Chat is OpenAI-compatible. <code>NESSIE_MODEL_BASE_URL</code> is the endpoint,{' '}
      <code>NESSIE_MODEL_API_KEY</code> the bearer, and <code>NESSIE_MODEL_PROVIDER</code> names the
      adapter — Nessie compiles adapters for <code>openai</code>, <code>kimi</code> and{' '}
      <code>deepseek</code>, and reaches anything else through the generic OpenAI-compatible connector.{' '}
      <code>NESSIE_MODEL_NAME</code> sets the deployment’s default model, which an individual agent’s own
      model selection still outranks.
    </p>
    <p>
      <strong>Embeddings are routed separately</strong>, because the chat provider may not serve them at
      all — DeepSeek, for instance, has no embeddings endpoint. Every unset{' '}
      <code>NESSIE_EMBEDDING_*</code> field inherits the chat provider, so a deployment that sets none of
      them embeds through the chat endpoint. Set <code>NESSIE_EMBEDDING_PROVIDER</code>,{' '}
      <code>NESSIE_EMBEDDING_MODEL</code> and, on a proxy that routes by service, the service segment,
      when the chat provider cannot embed. Getting this wrong fails quietly rather than loudly: memory
      recall and knowledge-base search degrade to a lexical channel and carry on, logging{' '}
      <code>kb_search: query embedding failed</code> as they go.
    </p>
    <p>
      Nessie’s own spend accounting — the per-organisation token ledger and the budget gate — is unaffected
      by which endpoint you point it at, and works identically whether or not signed per-call attribution
      is configured.
    </p>

    <h2>Signing in</h2>
    <p>
      Nessie authenticates people through UnlikeOtherAI (UOA), which is also the authority for the
      organisation and team structure. The admin login page shows a single “Sign in with SSO” button.
    </p>
    <p>
      The integration is a config-JWT flow rather than standard OIDC: the API serves a signed RS256 config
      document at <code>GET /api/auth/sso/config</code> and the matching JWKS at{' '}
      <code>GET /.well-known/jwks.json</code>, both on the API host. Standing it up is a one-time
      sequence — generate an RSA-2048 keypair and set <code>UOA_CONFIG_JWT_PRIVATE_KEY_B64</code>,{' '}
      <code>UOA_CONFIG_JWT_KID</code>, <code>UOA_DOMAIN</code>, <code>UOA_CONFIG_URL</code>,{' '}
      <code>UOA_JWKS_URL</code>, <code>UOA_REDIRECT_URL</code> and <code>UOA_CONTACT_EMAIL</code>; click the
      button once, which raises an integration request; have it approved, which sends a one-time link to
      the contact address carrying the client secret; set <code>UOA_CLIENT_SECRET</code> and restart the
      API. The <code>kid</code> must be unique per domain.
    </p>

    <h2>Putting it behind a domain, with TLS</h2>
    <p>
      A deployment serves three names: the public site, the admin, and the API. <strong>The admin and the
      API origins are not interchangeable.</strong> <code>Dockerfile.admin</code> bakes{' '}
      <code>VITE_API_BASE_URL</code> into the bundle at build time, so every built admin artifact — including
      a desktop build that embeds it — must be built against the API origin. Build it against the admin’s
      own origin and <code>/api/auth/providers</code> resolves to the admin’s HTML shell, leaving login
      stuck on “Loading providers...”.
    </p>
    <p>
      Production terminates TLS at Caddy, which obtains per-hostname certificates over HTTP-01 and needs no
      DNS-provider plugin for that. Point the proxy at the admin and web containers on port 80 and at the
      API on its internal port.
    </p>
    <p>
      Set <code>NESSIE_API_TRUSTED_PROXY_HOPS</code> to the number of proxies in front of the API — 1 behind
      a single reverse proxy. It defaults to <code>0</code>, which ignores <code>X-Forwarded-For</code>{' '}
      entirely. This is one decision with two consequences: it is also what keys the authentication
      rate limits, so too low and every client shares the proxy’s bucket, too high and a client can forge
      its own address. Err low and measure it.
    </p>
    <p>
      Serving each organisation and team at its own subdomain is possible and off by default. It is
      governed by <code>NESSIE_TEAM_HOST_BASE_DOMAIN</code>, unset means tenants are not routed by hostname
      at all, and the certificate-issuance gate <code>NESSIE_TLS_CHECK_KEY</code> refuses everything while
      it is unset — which is the right default for a deployment that does not use the feature.
    </p>

    <h3>Health checks</h3>
    <table>
      <thead>
        <tr>
          <th>Endpoint</th>
          <th>Question it answers</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>GET /api/health</code></td>
          <td>Is this process alive? Fails only once it has begun draining.</td>
        </tr>
        <tr>
          <td><code>GET /api/health/ready</code></td>
          <td>May this replica take new requests? This is the one to point a load balancer at.</td>
        </tr>
        <tr>
          <td><code>GET /api/ops/health</code></td>
          <td>
            How is the deployment doing? A report for a person — worker heartbeats, queue depth, dead jobs —
            not a probe.
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      On <code>SIGTERM</code> the API drains rather than dying where it stands.{' '}
      <code>NESSIE_SHUTDOWN_TIMEOUT_MS</code> bounds that drain and defaults to 25 seconds; keep it under
      whatever grace period your orchestrator gives the container, or the runtime kills the process first
      and the drain buys nothing.
    </p>

    <h2>Upgrading</h2>
    <p>
      An upgrade is <code>prisma migrate deploy</code> against the existing database, then the seeds, then{' '}
      <code>reconcile</code>. The same four commands as the first deploy.
    </p>
    <p>
      The path is tested for the route a self-hoster actually takes rather than against a fresh database:
      CI restores a snapshot taken twenty migrations behind, migrates it to the current head, validates
      the schema and runs a smoke check over the core tables. Any release inside that trailing window is
      a proven upgrade source. Migration folders are immutable once committed, and a lint step fails the
      build if one is renamed, renumbered, deleted or modified, because all four break{' '}
      <code>migrate deploy</code> for a database that already recorded the old row.
    </p>
    <p>
      <strong>One failed migration parks every deploy after it.</strong> <code>migrate deploy</code> stops
      at the first failure and refuses every later migration with <code>P3009</code>, so the installation
      stays on the old release until somebody clears it by hand. The project’s own production spent a day
      rejecting every deploy this way. Clearing one means confirming the failed migration really did roll
      back — none of the objects it creates should exist, anything it alters should still be in its
      original shape — and only then resolving it as rolled back. A migration that half-applied is not a
      candidate.
    </p>
    <p className="n-placeholder">
      Backup and restore for the self-hosted Compose deployment is not documented in the repository, so
      this page does not describe a procedure for it.
    </p>

    <h2>One machine, or a managed cloud</h2>
    <p>
      The single-host Docker Compose path above is the one that is proven: it is what the project’s own
      production runs, on a single server, with the database, object storage, API, worker, admin and site
      as containers behind a shared reverse proxy.
    </p>
    <p>
      Scaling past one machine changes three things, all of which are enforced rather than advised.
      Outside <code>local</code> mode Nessie runs the API and the worker as separate processes, and as
      several copies of each, so any capability that assumes one process owns the machine’s disk is
      refused: filesystem object storage (a start-up failure), execution-environment templates with the{' '}
      <code>docker</code> provider (inert, and provisioning fails loudly), and the{' '}
      <code>file_read</code>, <code>file_write</code> and <code>file_glob</code> builtin tools (a failed
      tool result the agent can read). Each refusal names the setting, the mode, and what to use instead.
    </p>
    <p>
      For a managed cloud the repository carries a Terraform tree in{' '}
      <code>infrastructure/terraform/</code> targeting Google Cloud: the API as a Cloud Run service with a
      minimum of one instance — it holds a persistent Postgres <code>LISTEN</code> client and runs
      maintenance sweeps, so scaling it to zero stops realtime delivery — the worker as a Cloud Run worker
      pool, because it binds no port and a Service would never become ready, a migrate job that gates every
      rollout, Cloud SQL for PostgreSQL 17, and a GCS bucket reached through the S3-compatible backend.
    </p>
    <p>
      <strong>That path is written, not walked.</strong> The repository says so plainly, and so does this
      page: no Google Cloud project exists for it, nothing in the tree has been planned or applied against
      a real project, the multipart upload path to GCS is untested against a real bucket, the worker-pool
      resource type is unvalidated, and the trusted-proxy hop count in it is a placeholder to be measured
      rather than a measurement. The admin and the public site are not modelled there at all. Treat it as
      a starting point you verify, not a supported deployment.
    </p>

    <h2>The licence</h2>
    <p>
      Nessie is licensed under the Functional Source License, Version 1.1, with an Apache 2.0 future
      licence (FSL-1.1-ALv2). Self-hosting is free, including for a commercial organisation running it for
      its own internal use, and you may inspect, modify and fork it for that use. What you may not do is
      take a current release and offer it as a competing hosted product. Each release becomes Apache
      License 2.0 two years after it ships.
    </p>
    <p>
      Where a deployment’s data lives, what the software holds and what it deliberately does not, is a
      separate page: <Link to="/eu">EU made, and where your data lives</Link>. The full deployment
      documentation, including every configuration variable, lives in <code>docs/deployment/</code> in
      the <a href="https://github.com/UnlikeOtherAI/nessie">source repository</a>.
    </p>
  </>
)
