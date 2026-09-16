// Remote executors. The prose is the page; the title, lede, route, sidebar
// entry and menu entry all come from `registry.ts`.
//
// Every claim here is checked against the repository it documents:
// docs/executor-protocol/overview.md and
// docs/executor-protocol/sandbox-forced-egress-and-credentials.md for the
// protocol and the sandbox, packages/schemas/src/executor{,-platform}.ts for
// the operation, scope and platform vocabulary, api/prisma/schema.prisma and
// api/src/routes/executor* for the control plane, executor/packaging and
// docs/running-the-apps/* for the install steps, and
// admin/src/pages/ExecutorsPage.tsx for what a person actually sees. Where the
// repository does not yet answer a question a reader would reasonably ask, the
// page says so in a dashed gap rather than filling it in.
export const ExecutorsPage = () => (
  <>
    <h2>What a remote executor is</h2>
    <p>
      An agent in Nessie has no computer. It can read what is in Nessie, talk to people and call
      connected tools over the network — but it cannot open a file on a laptop, run a command, or
      look at a page that only exists behind somebody&rsquo;s login. A remote executor is how you
      give one a machine to work on.
    </p>
    <p>
      An executor is a small daemon you install on a computer you control. It pairs outwards with
      your Nessie instance, proves which machine it is with a key that never leaves the host, and
      then offers a fixed, named set of operations — nothing else. Work arrives as individual
      signed commands; results come back as bounded, structured receipts. The machine never accepts
      an inbound connection from Nessie.
    </p>
    <p>
      It is worth being precise about what an executor is <strong>not</strong>, because most
      remote-access tools are one of these things and an executor is deliberately none of them.
      There is no SSH, no ambient remote shell, no attaching to a terminal multiplexer you already
      have open, no cloud-side standard input and no general local-network proxy. It is not an MCP
      server, and it is not a container or cloud execution environment — Nessie has those already,
      and they are a different thing. An executor is a capability-bearing endpoint with a closed
      list of operations, and that list is the entire surface.
    </p>

    <h3>Who an executor belongs to</h3>
    <p>
      Every executor is created with exactly one scope, and that scope cannot be changed
      afterwards. It decides who may invoke the executor and who may administer it.
    </p>
    <table>
      <thead>
        <tr>
          <th>Scope</th>
          <th>Who may invoke it</th>
          <th>Who manages access</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Private</td>
          <td>
            The requesting person and the exact invoked agent must <em>both</em> be named
            assignees. Neither alone is enough.
          </td>
          <td>
            An assigned human administrator. Agents can only use a private executor, never
            administer it.
          </td>
        </tr>
        <tr>
          <td>Project</td>
          <td>A person entitled to that exact project, and only from a run in that project.</td>
          <td>An organisation manager, or a project owner or admin.</td>
        </tr>
        <tr>
          <td>Organisation</td>
          <td>A person with organisation entitlement.</td>
          <td>An organisation manager.</td>
        </tr>
      </tbody>
    </table>
    <p>
      A private executor must always have at least one active human administrator. Removing the
      last one directly fails; if an offboarding transaction would leave none, the executor stops
      accepting new work, drains what it has and revokes itself. An organisation owner has a
      revocation-only break-glass path that ends an executor they do not otherwise manage, without
      showing them its private roster, its sessions or its content — private access is never
      silently transferred to somebody else.
    </p>

    <h2>What an agent can actually do with one</h2>
    <p>
      The operation vocabulary is fixed in code, not configured per deployment. It divides in two,
      and the division decides what you need to install: some operations the daemon serves from its
      own scratch directory with no virtual machine at all, and the rest need a per-session guest VM
      on the host.
    </p>
    <table>
      <thead>
        <tr>
          <th>Operation</th>
          <th>What it does</th>
          <th>Guest VM</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>file.list</code>, <code>file.read</code>
          </td>
          <td>List and read files beneath the one workspace root chosen when pairing.</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>file.write</code></td>
          <td>
            Write into a copy-on-write draft of that workspace. It never opens the real root for
            writing.
          </td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>workspace.review</code></td>
          <td>
            Report what the draft changed — up to 100 relative paths with kind and byte count, plus
            a manifest digest. It carries no file contents.
          </td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>sandbox.stop</code></td>
          <td>Tear down the session this run owns.</td>
          <td>No</td>
        </tr>
        <tr>
          <td><code>command.run</code></td>
          <td>
            Run one command as a shell-free argument vector in a guest with no egress. There is no
            shell string anywhere in this path.
          </td>
          <td>Yes</td>
        </tr>
        <tr>
          <td>
            <code>browser.open</code>, <code>browser.observe</code>, <code>browser.act</code>
          </td>
          <td>
            Drive a browser inside the guest against an origin list configured on the machine.
            Observation returns a bounded accessibility tree and an optional downscaled image;
            actions are navigate, click, type, press and scroll against a node the agent has just
            observed — never a selector, a coordinate or a script.
          </td>
          <td>Yes</td>
        </tr>
        <tr>
          <td>
            <code>coding.launch</code>, <code>coding.observe</code>
          </td>
          <td>
            Start a managed Codex session in the guest and read back typed lifecycle state. There is
            no terminal attach and no prompt channel: the agent learns whether the session is
            running, not what is on its screen.
          </td>
          <td>Yes</td>
        </tr>
        <tr>
          <td><code>workspace.promote</code></td>
          <td>
            Apply a reviewed draft to the real workspace. This is the only operation that writes to
            the host, and it is deliberately not offered to models at all.
          </td>
          <td>No</td>
        </tr>
      </tbody>
    </table>
    <p>
      The operations that need no guest are the <strong>workspace bundle</strong>. A host that
      cannot start a guest is not a broken executor: it pairs normally, reports its sandbox backend
      as <code>none</code>, and advertises the workspace bundle and nothing else. That is the state
      a Windows edition without Hyper-V, or a Linux machine whose user cannot use{' '}
      <code>/dev/kvm</code>, ends up in, and the interface names it rather than failing obscurely.
    </p>
    <p>
      Browser work is never something an agent starts on its own initiative. The ordinary
      single-operation binding route refuses <code>browser.open</code> and{' '}
      <code>browser.observe</code> outright; a browser run is launched by a person from a channel,
      as one bundle of four operations on a fresh run, and no further binding can be added to it
      afterwards. Managed coding sessions work the same way.
    </p>
    <p>
      Two further groups exist in the code and are deliberately unavailable. Operations for driving
      a Chrome tab you are already signed into have a complete local implementation and a
      native-messaging extension, but the control plane refuses to advertise them until the server
      can prove the originating conversation was private and record who disclosed what — the
      foundation is inert on purpose, and the extension is not shipped in either installer. And
      several coding operations — attach, prompt, interrupt and close — are named in the schema but
      have no implementation, so they cannot be granted.
    </p>

    <h2>How it works</h2>

    <h3>The connection is outbound, always</h3>
    <p>
      The daemon makes outbound HTTPS and WSS connections to your Nessie API and nothing else.
      Nessie never dials a laptop, never holds an address for one, and never treats any catalogue
      endpoint as a machine transport. That is why an executor works from a home network, behind
      NAT, on a corporate VPN, with no port forward and no inbound firewall rule — and why stopping
      the daemon is a complete and immediate disconnection.
    </p>
    <p>
      The API origin must be HTTPS. The single exception is a loopback address for people running
      Nessie on their own machine, behind its own environment variable; no ordinary flag turns a
      production origin into plain HTTP.
    </p>

    <h3>Pairing proves a machine, and a person confirms it</h3>
    <p>
      Pairing is a two-sided proof. An entitled person creates the executor in Nessie with its
      scope, and Nessie issues an enrolment: a 256-bit random challenge of which it stores only a
      SHA-256 verifier, valid for ten minutes and usable once.
    </p>
    <p>
      On the machine, the daemon generates an Ed25519 key pair, stores it in owner-only OS-protected
      storage, and writes the exact signed request to disk <em>before</em> it makes any network
      call — so a lost response can be retried with the same prepared key rather than quietly
      pairing twice. It then submits the enrolment id, the challenge, its public key and a proof
      signature. Nessie stores the public key and its fingerprint. It never stores the private key.
    </p>
    <p>
      Nessie then shows that fingerprint to a person, who confirms it. Until that confirmation and a
      subsequent proof of possession, the executor stays offline. Pairing can never be completed
      from chat text or a terminal transcript: it takes a deliberate human action in the web or
      desktop interface.
    </p>
    <p>
      A machine that loses its key cannot reclaim its executor record. It is revoked and enrolled
      again as a new executor. Key rotation, by contrast, is a single transaction signed by both the
      old key and the new one.
    </p>

    <h3>The descriptor is the machine&rsquo;s signed claim about itself</h3>
    <p>
      A paired daemon publishes a <strong>descriptor</strong>: a signed, monotonically revised
      statement of structural facts only — which operation schemas it supports, its resource and
      network limits, its platform, and a digest of its local policy. It carries no host paths and
      creates no authority in the cloud.
    </p>
    <p>
      A new revision is never activated on arrival. It is stored pending review, and an entitled
      person has to see it and confirm it before it can affect what is available. That is what stops
      a capability refresh from silently granting new power: a newly advertised operation starts
      denied.
    </p>
    <p>
      Be clear about what the signature proves. A descriptor signed by a paired executor key proves
      that key made the claim. It does not prove the host is uncompromised, and the interface is
      required to say so.
    </p>

    <h3>Dispatch: candidate, binding, command, receipt</h3>
    <p>
      An agent never names an executor. Before a run can use one, Nessie resolves the logical
      operation into an opaque, short-lived <em>availability candidate</em>. The response contains
      no executor id; the database keeps only a digest of the handle alongside who and what it was
      resolved for. Models and clients receive a handle, not a selectable machine.
    </p>
    <p>Availability is one resolver, used identically by the API, the worker, the UI and the assistant:</p>
    <pre><code>{`available(operation, human, agent, immutableRunContext) =
  human may discover executor
  ∩ exact executor-agent-operation grant allows operation
  ∩ stable logical tool grant allows operation
  ∩ scope matches immutable run context
  ∩ executor is online and descriptor is approved
  ∩ local policy permits operation`}</code></pre>
    <p>
      Consuming the candidate creates a <strong>binding</strong> under a database lock that rechecks
      every one of those gates a second time and advances a monotonic fence. Dispatch rechecks them
      again. The consequence is that a grant withdrawn, a policy narrowed or an executor revoked
      between two steps stops the work rather than being noticed afterwards — and a retry can never
      land on a different machine than the one the run was bound to.
    </p>
    <p>
      The command itself rides on Nessie&rsquo;s ordinary queue job and tool-call lifecycle rather
      than a second one of its own. The daemon polls for work over its authenticated control
      channel; it is never pushed to. A command moves through four receipts and no others:
    </p>
    <pre><code>leased → accepted → started → result-acknowledged</code></pre>
    <p>
      Every frame binds the command id, the run provenance, the binding fence, the capability
      revision, an expiry, an idempotency key and digests of both the arguments and the payload. The
      daemon refuses a mismatch, a stale policy, a replay, or a second result for a command it has
      already completed. Arguments and terminal results are encrypted with AES-256-GCM at rest; the
      database keeps bounded ciphertext and canonical digests, not content.
    </p>
    <p>
      If an acknowledgement is lost, Nessie does <em>not</em> assume success. The command is
      recorded as an unknown outcome and the run follows the normal recovery path; the daemon, which
      journals each delivered command locally before it starts work, will not repeat the side
      effect. A late receipt can still resolve the ambiguity honestly.
    </p>

    <h3>Trust boundary</h3>
    <table>
      <thead>
        <tr>
          <th>Principal</th>
          <th>Can</th>
          <th>Cannot</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Person</td>
          <td>Pair an executor, manage it when entitled, confirm access and policy changes.</td>
          <td>Widen a policy the machine itself denies, or act without current entitlement.</td>
        </tr>
        <tr>
          <td>Agent, including the personal assistant</td>
          <td>
            Invoke an operation already available to it; prepare a proposed access change for the
            person who asked.
          </td>
          <td>
            Administer access, approve itself, pick a machine, change local policy, or apply a
            change it prepared.
          </td>
        </tr>
        <tr>
          <td>Nessie control plane</td>
          <td>Resolve availability, bind a run, lease commands, keep redacted audit facts.</td>
          <td>
            Dial the machine, widen local policy, reach host credentials, or treat terminal text as
            an authorisation or an outcome.
          </td>
        </tr>
        <tr>
          <td>Executor daemon</td>
          <td>Enforce local policy, pair outward, run the guest and gateway, acknowledge commands.</td>
          <td>
            Expand its own scope, accept stale or replayed work, expose the host workspace or
            credentials directly, or send raw local data into the audit trail.
          </td>
        </tr>
        <tr>
          <td>Guest VM and the tools inside it</td>
          <td>Work in a copy-on-write sandbox, reaching the network only through the gateway.</td>
          <td>Reach host files, host credentials, direct network or DNS, or promote a host change.</td>
        </tr>
      </tbody>
    </table>

    <h2>Installing an executor</h2>
    <p>
      Two things decide what you install: the operating system, and whether the machine should be an
      executor only while somebody is signed in with the Nessie desktop app open, or permanently.
    </p>
    <p>
      Those are the two <strong>supervisors</strong>. The desktop app packages the executor and
      supervises it for as long as the app runs. The standalone package instead installs a service
      that starts at boot and outlives a logout — which is what a machine that should be reachable
      when nobody is at it needs. An executor id has exactly one supervisor for the life of its
      pairing, because the two use different state directories, and the interface offers different
      controls accordingly.
    </p>
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Linux</th>
          <th>macOS</th>
          <th>Windows</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>Minimum host</th>
          <td>Kernel 5, x86_64 only</td>
          <td>macOS 15, Apple Silicon only</td>
          <td>Build 19045 (Windows 10 22H2), x64</td>
        </tr>
        <tr>
          <th>Standalone package</th>
          <td>
            <code>.deb</code>, systemd <em>user</em> service
          </td>
          <td>None — the desktop app is the only supervisor</td>
          <td>
            <code>.msi</code>, Windows service plus a tray icon
          </td>
        </tr>
        <tr>
          <th>Guest sandbox</th>
          <td>
            Firecracker, needs <code>/dev/kvm</code>
          </td>
          <td>Virtualization.framework</td>
          <td>Hyper-V generation 2 VM</td>
        </tr>
        <tr>
          <th>Trust root</th>
          <td>
            A root-owned package install under <code>/usr/lib</code>
          </td>
          <td>A Developer ID signature, with the team pinned into the build</td>
          <td>An Authenticode signature, with the publisher thumbprint pinned into the build</td>
        </tr>
        <tr>
          <th>Without virtualisation</th>
          <td>
            Workspace bundle only; the remedy is membership of the <code>kvm</code> group
          </td>
          <td>Not applicable on a supported host</td>
          <td>Workspace bundle only; Home editions have no Hyper-V to enable</td>
        </tr>
      </tbody>
    </table>
    <p>
      The trust-root row is worth reading twice. Every platform pins its own publisher, because a
      hash manifest sitting beside a binary is self-attestation: whoever can rewrite the binary can
      rewrite the manifest. A build that is not verifiably from the expected publisher still runs as
      an ordinary Nessie app — it simply never offers executor controls, and says why.
    </p>
    <p>
      Note the architecture limits, which are narrower than the operating-system list suggests.
      macOS requires Apple Silicon and refuses Intel outright; the Linux package is built for{' '}
      <code>amd64</code> only, so there is no Arm Linux executor; and Snap, Flatpak, RPM and the AUR
      are not targets.
    </p>
    <p className="n-placeholder">
      Where to download a released Linux package, Windows installer or signed macOS build: the
      repository builds and checksums all three in CI, but publishing them — the signed apt
      repository in particular — is unfinished, and no download location or repository key exists
      yet to put here.
    </p>

    <h3>Creating the executor in Nessie first</h3>
    <p>
      Installation starts in the web interface, not on the machine, because the machine needs an
      invitation before it has anything to pair with. Go to <strong>Agents → Executors</strong> and
      choose <strong>Pair executor</strong>. Give it a name, choose its scope, and — for a private
      executor — name the people and agents in the same step, giving each person <em>Use</em> or{' '}
      <em>Admin</em> and keeping at least one administrator. Agents receive use access only; each
      operation is granted separately afterwards.
    </p>
    <p>
      <strong>Create pairing</strong> produces the invitation: an enrolment id and a challenge, with
      an expiry, presented as a command to paste on the machine. It looks like this:
    </p>
    <pre><code>{`nessie-executor pair --api https://api.example --state-dir "$HOME/.nessie-executor" \\
  --workspace "/absolute/read-only/workspace" --enrollment <enrollmentId> --challenge <token>`}</code></pre>
    <p>
      Replace the workspace placeholder with one existing absolute directory — the single root the
      executor will ever see. If you are installing the standalone Linux package, also replace the
      state directory, which has to be the one the service unit expects (below). On Windows you
      paste the invitation into the tray rather than a terminal.
    </p>
    <p>
      Once the daemon has submitted its descriptor, return to the executor in Nessie, press{' '}
      <strong>Check pairing</strong>, compare the fingerprint it shows with the one the machine
      printed, and press <strong>Confirm fingerprint</strong>. Nothing is online until you do.
    </p>

    <h3>Linux</h3>
    <p>
      The standalone Linux daemon is a Debian package. It installs a launcher at{' '}
      <code>/usr/bin/nessie-executor</code>, a root-owned runtime under{' '}
      <code>/usr/lib/nessie-executor/</code> — its own copy of Node, the bundled CLI, a pinned
      Firecracker binary and the guest kernel, each with its SHA-256 recorded in a manifest — and a
      templated systemd <em>user</em> unit.
    </p>
    <p>
      Root ownership is the whole point. The daemon refuses to serve from a runtime that is not
      root-owned, not under <code>/usr/lib</code> or <code>/usr/share</code>, or not byte-identical
      to its manifest. Only an administrator can produce that state, so a copy in a home directory
      can never acquire executor controls — which is also why the AppImage build of the desktop app
      never gets them.
    </p>
    <p>
      Build the package from the repository with Node 22; the packaged runtime is a copy of the
      build host&rsquo;s Node.
    </p>
    <pre><code>{`node executor/packaging/linux/build-deb.mjs
# dist/nessie-executor_<version>_amd64.deb
# dist/nessie-executor_<version>_amd64.deb.sha256`}</code></pre>
    <p>Check it and install it:</p>
    <pre><code>{`sha256sum --check dist/nessie-executor_<version>_amd64.deb.sha256
sudo apt install ./dist/nessie-executor_<version>_amd64.deb`}</code></pre>
    <p>
      Pair with the state directory the service unit uses. The unit hard-codes{' '}
      <code>~/.local/state/nessie-executor/&lt;executorId&gt;</code>, and{' '}
      <code>enable</code> refuses any other path, so use it here rather than the generic one the web
      interface prints:
    </p>
    <pre><code>{`nessie-executor pair --api https://api.nessie.works \\
  --enrollment <enrollmentId> --challenge <token> \\
  --state-dir ~/.local/state/nessie-executor/<executorId> \\
  --workspace /absolute/path/to/workspace`}</code></pre>
    <p>Confirm the fingerprint in Nessie, then turn the service on:</p>
    <pre><code>{`nessie-executor enable <executorId>          # prompts before enabling lingering
nessie-executor enable <executorId> --yes    # unattended`}</code></pre>
    <p>
      That one command verifies the paired state and the packaged runtime, reloads your systemd user
      manager, enables and starts <code>nessie-executor@&lt;executorId&gt;</code>, and turns on
      lingering. Lingering deserves understanding rather than blind acceptance: it starts your
      systemd user manager at boot and keeps it running after you log out, which is the only reason
      an executor stays online with nobody signed in — and it applies to your whole user account,
      not only to this service. The command prints that before it asks, refuses to guess without a
      terminal unless you pass <code>--yes</code>, and changes nothing if you decline.
    </p>
    <p>
      The unit is a template with one instance per executor id, so a machine can host several
      pairings without them sharing state. It is a user unit, so the daemon runs as you and never as
      root — which is also why Firecracker is run directly rather than through its jailer, since the
      jailer needs root. Guest sandboxing additionally needs read and write access to{' '}
      <code>/dev/kvm</code>; without it the executor pairs and offers the workspace bundle only.
    </p>

    <h3>Windows</h3>
    <p>
      The standalone Windows package installs two programs: a service that owns the daemon, and a
      tray icon that controls it. Install it with a single administrator prompt:
    </p>
    <pre><code>{`Get-FileHash .\\NessieExecutor_<version>_x64.msi -Algorithm SHA256
msiexec /i .\\NessieExecutor_<version>_x64.msi`}</code></pre>
    <p>
      Everything lands in <code>C:\Program Files\Nessie Executor\</code>, and the{' '}
      <strong>NessieExecutor</strong> service is registered to start automatically as the virtual
      account <code>NT SERVICE\NessieExecutor</code> — no password, no interactive logon, its own
      security identifier. The installer adds that account to the built-in Hyper-V Administrators
      group, which is what lets it create and destroy per-session virtual machines; on an edition
      with no Hyper-V that group does not exist, the install succeeds anyway, and the executor pairs
      with the workspace bundle only. It also registers the Hyper-V socket identifiers the guest
      transport needs, creates the service&rsquo;s state directory under{' '}
      <code>%ProgramData%\Nessie Executor\</code>, and adds a startup entry so the tray appears at
      your next logon.
    </p>
    <p>
      Pair from the tray rather than a command line. In Nessie, <strong>Agents → Executors → Pair
      executor</strong> produces the invitation; in the tray, choose <strong>Pair a new
      executor…</strong>, paste it, select the Nessie backend that produced it, choose the workspace
      folder in the native picker, confirm, approve one administrator prompt, and confirm the
      fingerprint in Nessie. After a reboot the executor is online before anybody logs in. The tray
      compares the selected backend against the invitation before it creates a key or grants the
      folder, and never retries a different origin or moves pairing state between origins.
    </p>
    <p>
      That single administrator prompt has a specific job, and it is not installation. The daemon
      runs as a service account with no rights anywhere you keep your work, so somebody with
      administrative rights has to grant that account <em>read</em> access to the workspace root.
      The elevated step merges one entry into the folder&rsquo;s existing permissions — it never
      replaces them — and records the pairing account&rsquo;s identifier, which is what lets your
      ordinary, unelevated tray talk to the service afterwards without prompting again.
    </p>
    <p>
      The tray&rsquo;s colour is its status: grey for nothing running, green for a daemon up, amber
      for something in flight such as a fingerprint awaiting confirmation, red for a service that
      could not be reached or refused to supervise. The first line of the menu says which. Quitting
      the tray ends only the tray — the service and its daemons keep running, and the menu says so.
    </p>

    <h3>macOS</h3>
    <p>
      On macOS there is no standalone executor package. There is no installer, no launchd job and no
      service to enable: a Mac becomes an executor through the Nessie desktop app, which packages the
      executor and supervises it only while the app is running. A Mac that should be an executor
      therefore has to stay signed in with Nessie open. That is a real difference from Linux and
      Windows, not an omission from this page.
    </p>
    <p>
      macOS is also where the sandbox is furthest along. The per-session guest runs under
      Virtualization.framework on Apple Silicon, through a helper carrying the virtualisation and
      hypervisor entitlements; an unsigned or wrongly signed helper fails closed inside the framework
      before a guest can start.
    </p>
    <p>
      Executor controls require a release signed with the Developer ID team pinned into the build.
      An ad-hoc signature is enough to run the desktop app; it is deliberately not enough to pair an
      executor, and replacing a pinned build with a differently signed copy leaves its executor
      controls unavailable on purpose. The Mac App Store build does not bundle the executor runtime
      at all, because that helper depends on a Developer ID signature and user-selected folder access
      that has not been redesigned for the App Sandbox.
    </p>

    <h3>How far each platform has actually been proven</h3>
    <p>
      The state of the three guest sandboxes differs, and the difference is material. macOS is the
      backend with a working, exercised guest path. The Firecracker backend on Linux and the Hyper-V
      backend on Windows are implemented and covered by host-side tests — the launch sequence, the
      disk images, the control and egress transports, the draft protocol — but no guest has yet
      booted on real hardware in this project&rsquo;s continuous integration, because that needs a
      machine with KVM or Hyper-V and the jobs that would prove it have never had one. The workspace
      bundle, which needs no guest, is exercised end to end on Windows against a real control loop.
      Treat guest-backed operations on Linux and Windows as unproven until you have proven them on
      your own hardware. The pairing screen in Nessie says the same thing in its own words.
    </p>

    <h2>Security and containment</h2>

    <h3>One workspace root, and its path stays on the machine</h3>
    <p>
      Pairing selects exactly one canonical workspace root: one directory, not a set of folders, and
      never their nearest common parent. Nessie is told the root&rsquo;s basename, so a person can
      recognise the boundary in the interface; the full path stays in owner-only machine state and is
      never uploaded. Changing the root is possible, but only after every local draft and sandbox has
      been removed, and it produces a new descriptor revision that goes through the same human review
      as any other policy change. It can never silently widen to a parent directory.
    </p>
    <p>
      File operations accept relative paths only. They reject traversal and every symbolic-link
      component, re-check that the configured root is still an ordinary directory, and return bounded
      structured results containing no host path.
    </p>

    <h3>Writes go to a copy, and only a person promotes them</h3>
    <p>
      An agent never writes to your files. <code>file.write</code> creates a bounded copy-on-write
      tree under the daemon&rsquo;s own state directory, keyed to the run, and later reads and
      listings for that run see the draft. Guest work, including coding sessions, uses the same
      copy-on-write scratch.
    </p>
    <p>
      Applying a draft to the real workspace is a single operation — <code>workspace.promote</code> —
      and it is the only host write in the system. It has no model-facing schema at all: no agent, no
      assistant and no caller-supplied path can turn a draft into a host write. Instead a person
      opens <strong>Your reviewed drafts</strong>, presses <strong>Review promotion</strong>, and
      confirms with their current password. The server then rechecks the acknowledged review digest,
      the manifest digest, the originating run, user and agent, the authorisation revision, the
      operation grant and the active local policy before it creates the command. On the machine, the
      daemon rebuilds the manifest itself and refuses a digest that has changed — so an edit made
      after the review cannot ride in on the review&rsquo;s approval.
    </p>
    <p>
      The apply itself is descriptor-based and journalled. The native helper receives the workspace
      root and the draft as already-open directory descriptors, never as paths; it validates every
      component with no-follow operations, refuses symbolic links, hard links, special files and
      mount crossings, and keeps an all-or-recover journal so that a crash either finishes the
      validated manifest or restores the original before anything else runs.
    </p>

    <h3>The guest has no network, and egress is forced</h3>
    <p>
      When an operation does need a guest, it is a per-session Linux micro-VM with no host home, no
      Docker socket, no SSH agent, no inherited environment and no host mount other than the
      workspace share. The executable runtime mount is read-only; the writable workspace mount
      forbids execution, so anything that runs comes from the verified runtime payload rather than
      from something an agent wrote. The guest drops to an unprivileged identity before it opens any
      socket, and a root-owned share fails the boot rather than leaving a privileged workload
      running.
    </p>
    <p>
      Most importantly, the guest has no network interface. On Linux the launch sequence deliberately
      never configures one and no TAP device is created; on Windows the virtual network adapter
      Hyper-V adds by default is removed during setup. The guest&rsquo;s only route off the machine
      is a loopback proxy inside it, tunnelled over a virtual socket to a bridge on the host, which
      hands the bytes to the daemon&rsquo;s own gateway — an owner-only local socket listener with no
      TCP listener and no general forwarding mode. That gateway is where HTTP, CONNECT, WebSocket,
      redirect, origin, download and upload policy is enforced, using Nessie&rsquo;s existing
      pinned-fetch machinery rather than a second implementation of the same rules. There is no NAT
      bridge and no direct DNS resolver: alternate DNS, raw TCP, QUIC and proxy bypass are all
      denied.
    </p>
    <p>
      The origin list that gateway enforces is configured on the machine, by its owner, and is
      deliberately never uploaded. The interface names that absence rather than pretending Nessie is
      an origin-policy editor: to know what a browser executor may reach, ask the person who owns the
      machine.
    </p>

    <h3>Credentials</h3>
    <p>
      No host credential store is ever mounted into a guest. Not the keychain, not{' '}
      <code>~/.codex</code> or <code>~/.claude</code>, not a global CLI token, not an environment
      variable carrying an API key. The only supported login for a managed coding session is an
      owner-private authentication file whose contents are read solely by the owner-controlled initrd
      builder — never by Nessie, never by the descriptor, never by a log or a command argument — and
      moved once into a private home inside the guest, which is destroyed with the VM. That guest can
      reach exactly one origin.
    </p>
    <p>
      The browser executor is stricter still: each session gets a fresh private browser profile and
      refuses one prepared by the workspace, so it starts with no cookies, no extensions and no
      ambient signed-in state.
    </p>
    <p>
      Raw local data can reach a model provider only inside an explicit, bounded run. What Nessie
      persists is redacted manifests, argument and policy digests, result digests and structured
      status. File contents, terminal output, browser DOM, credentials and authentication factors are
      forbidden from database records, audit entries, logs, realtime events and error reports.
    </p>

    <h3>What an operator grants, and how they take it back</h3>
    <p>
      Permission to use an executor is not one switch. An agent can invoke an operation only when it
      holds a grant for that <em>exact</em> executor and that <em>exact</em> operation, <em>and</em>{' '}
      the ordinary logical tool policy allows it, <em>and</em> the run&rsquo;s scope matches,{' '}
      <em>and</em> the machine&rsquo;s own local policy permits it. Granting one executor an
      operation therefore authorises nothing on another, and a capability refresh cannot widen
      anything, because new operations arrive denied.
    </p>
    <p>
      Every change is two steps, and the second one is always a person. On the executor&rsquo;s{' '}
      <strong>Operations</strong> tab a manager picks an agent, an operation and allow or deny, and
      presses <strong>Review operation change</strong>; on <strong>Access</strong> they prepare a
      private assignment the same way. Preparing records the exact difference and returns a
      single-use token; a confirmation card then shows the change itself and asks for confirmation.
      The assistant can prepare a change on your behalf — only in your own assistant conversation,
      never in a shared channel, a scheduled job or another agent&rsquo;s run — but it has no
      confirmation tool at all. Chat text is never a confirmation.
    </p>
    <p>
      Four changes additionally require you to re-enter your current password at the moment of
      confirmation: setting or removing a private assignment, allowing an agent an operation,
      activating a descriptor revision, and revoking an executor. Promotion of a reviewed draft always
      does. The audit trail records the acting person and the assistant&rsquo;s involvement
      separately.
    </p>
    <p>An executor moves through a small, explicit set of states:</p>
    <pre><code>{`pending_pairing → online ↔ offline
        │             ↓
        └──────────→ draining → revoked
                         ↓
                       error`}</code></pre>
    <p>
      The <strong>Attention</strong> tab is where a manager prepares the three lifecycle changes:
      pause, drain and revoke. Pausing leaves an executor online but stops it accepting commands.
      Draining accepts no new binding and cancels active commands. Revoking invalidates its client
      certificates and every outstanding candidate handle, and cannot be undone — there is no delete
      button, and a revoked executor is re-paired as a new one. Every confirmed access change,
      descriptor review and lifecycle transition also advances the daemon&rsquo;s connection epoch,
      so its next control poll — at most a second later — fails closed and stops every live guest
      before it can reconnect. Revocation is not a request the machine may ignore.
    </p>

    <h2>Operating an executor</h2>

    <h3>Checking it is healthy</h3>
    <p>
      Nessie&rsquo;s own answer is liveness. A daemon signs a heartbeat, and an executor whose last
      authenticated activity is older than sixty seconds is durably marked offline before it can be
      listed, selected or dispatched to. An executor that shows as online has proven itself within
      the last minute.
    </p>
    <p>
      There is no health endpoint on the machine — the daemon listens on no operator-facing port at
      all, by design. On Linux, ask it directly:
    </p>
    <pre><code>{`nessie-executor status                # every paired executor, plus linger state
nessie-executor status <executorId>
systemctl --user status nessie-executor@<executorId>`}</code></pre>
    <p>
      That command is Linux-only and refuses to run elsewhere, because it controls a systemd user
      service. On Windows the tray icon is the at-a-glance answer, its menu names the reason, and the
      service log carries the detail. On either platform the executor&rsquo;s{' '}
      <strong>Overview</strong> tab in Nessie shows its approved profiles, its data boundary, when it
      was last seen and any pending local policy proposal awaiting review.
    </p>

    <h3>Logs</h3>
    <table>
      <thead>
        <tr>
          <th>Platform</th>
          <th>Where</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Linux</td>
          <td>
            <code>journalctl --user -u nessie-executor@&lt;executorId&gt;</code>; the daemon keeps no
            log file of its own
          </td>
        </tr>
        <tr>
          <td>Windows</td>
          <td>
            <code>%ProgramData%\Nessie Executor\logs\service.log</code>, which the tray&rsquo;s{' '}
            <strong>Open logs folder</strong> opens
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      Every refusal a person can act on lands there: an unsigned or tampered runtime, a state
      directory that would not secure, an executor that did not start at boot. What never lands there
      is a pairing challenge, a key, or a child process&rsquo;s output. There is no log-level setting
      to raise, because there is nothing more verbose to turn on.
    </p>
    <p className="n-placeholder">
      Where a macOS executor writes its daemon log: not established. The desktop app writes nothing
      to disk of its own, and no separate macOS log location is documented in the repository.
    </p>

    <h3>Upgrading</h3>
    <p>
      There is no in-app updater, by decision. The Nessie web interface updates itself without any
      local release, so most changes reach an installed app simply by reloading it; an update to the
      shell or the executor is a reinstall. On Windows, running the newer installer over the old one
      keeps the URL-scheme registration and every local pairing. On Linux, install the newer package
      the ordinary way. Pairings live in machine state rather than in the program, so they survive.
    </p>

    <h3>Stopping and removing</h3>
    <p>
      Stopping is a graceful path the daemon owns, not a kill. It receives a termination signal,
      stops every guest session, releases its lease and exits. On Linux the unit waits fifteen
      seconds for a ten-second teardown budget and deliberately never escalates to an uncatchable
      kill — because a daemon killed mid-teardown strands a micro-VM and a workspace overlay with no
      process left to clean them up. A stop that hangs is therefore visible in{' '}
      <code>systemctl --user status</code> rather than silent, and escalating is an explicit human
      decision.
    </p>
    <p>To remove the Linux package:</p>
    <pre><code>{`nessie-executor disable <executorId>   # stops and disables the service
sudo apt remove nessie-executor
loginctl disable-linger                # only if your user manager should stop running at boot too`}</code></pre>
    <p>
      On Windows, <code>msiexec /x</code> stops and removes the service, its registry entries and the
      tray&rsquo;s startup entry. On both platforms the paired state is deliberately left behind —{' '}
      <code>~/.local/state/nessie-executor/</code> on Linux and{' '}
      <code>%ProgramData%\Nessie Executor</code> on Windows. A pairing is a machine key and a signed
      policy revision, and uninstalling a program is not a request to destroy them; reinstalling
      finds them where they were. Delete the directory by hand to forget a pairing, and revoke the
      executor in Nessie to end it from the other side.
    </p>
    <p>
      The Windows tray and the desktop companion both offer{' '}
      <strong>Forget pairing on this computer</strong> as a first-class action: it stops the local
      daemon, removes the machine key and the folder selection, and permanently deletes the local
      draft copies after one native confirmation — while leaving the server-side executor and its
      audit history for an owner to keep or revoke.
    </p>

    <h3>Common failures</h3>
    <table>
      <thead>
        <tr>
          <th>Symptom</th>
          <th>What it means</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>The executor pairs but offers only file operations</td>
          <td>
            The host reported no usable sandbox backend. On Linux, check whether you can read and
            write <code>/dev/kvm</code> and whether you are in the <code>kvm</code> group — log out
            and back in after adding yourself. On Windows, the edition has no Hyper-V; it is an
            edition, not a setting.
          </td>
        </tr>
        <tr>
          <td>Executor controls are missing entirely</td>
          <td>
            The build is not verifiably from the expected publisher. On Linux the runtime must be
            root-owned with no group or world write bit; on Windows and macOS the signature must match
            the thumbprint or team pinned into the build. Each of these refuses in words and names the
            remedy rather than hiding the controls.
          </td>
        </tr>
        <tr>
          <td>The service runs but starts no daemon and refuses every command</td>
          <td>
            Something in the install was replaced after packaging. This is the intended behaviour: a
            tampered install answers with the reason instead of disappearing, because a stopped
            service would make the tray name the wrong remedy.
          </td>
        </tr>
        <tr>
          <td>A run ends with an unknown outcome</td>
          <td>
            A terminal acknowledgement was lost. Nessie will not report a result it did not receive:
            the command is marked unknown, the run takes the recovery path, and the side effect is not
            repeated. A late receipt from the daemon can still resolve it.
          </td>
        </tr>
        <tr>
          <td>An operation that worked yesterday is refused today</td>
          <td>
            A gate changed between binding and dispatch, and the checks are repeated at every step: a
            grant withdrawn, a descriptor revision awaiting review, a narrowed local policy, a scope
            that no longer matches the run, or a revocation. The refusal names which.
          </td>
        </tr>
        <tr>
          <td>An agent asks for a browser and is told it cannot</td>
          <td>
            Browser and coding work are launched by a person from a channel as a whole bundle on a
            fresh run. The ordinary binding route refuses them by design, and no browser operation can
            be added to a run that is already doing something else.
          </td>
        </tr>
      </tbody>
    </table>
  </>
)
