import { Link } from 'react-router-dom'

export const ExecutorSetupPage = () => (
  <>
    <h2>Choose the computer and installer</h2>
    <p>
      An executor runs on a computer you control and connects out to Nessie. Install it under the
      operating-system account that should own its files and local programs. For personal Claude,
      Codex or terminal sessions, choose a private executor under that same account. Pairing does
      not install or sign in to those programs for you.
    </p>
    <table>
      <thead><tr><th>Computer</th><th>Install and startup</th><th>Availability</th></tr></thead>
      <tbody>
        <tr>
          <td>Mac</td>
          <td>
            Install the separate <strong>Nessie Executor</strong> menu bar app from a signed,
            notarized disk image. Open it and enable <strong>Start at login</strong> if you want it
            to reconnect after signing in. Quitting the app stops its daemon; closing its panel does
            not. The Mac App Store Nessie app does not include the executor, so it needs this separate
            app. A Developer ID Desktop build may include the same menu bar helper.
          </td>
          <td>
            The release workflow produces Apple Silicon and Intel images. Check the published release
            assets for your Mac before downloading. Homebrew distribution is planned; there is no
            formula or install command to use yet.
          </td>
        </tr>
        <tr>
          <td>Windows</td>
          <td>
            The standalone signed MSI installs a service that starts at boot and a tray app for
            pairing and local controls. A service runs under its own account: it cannot run your
            personal Claude terminal. For that, use an executor supervised by Nessie Desktop in
            your signed-in Windows session. Select one supervisor for a pairing.
          </td>
          <td>
            Check published release assets for the standalone MSI or signed Desktop installer.
            Microsoft Store distribution is planned; no Store listing or product ID is available
            here yet.
          </td>
        </tr>
        <tr>
          <td>Linux</td>
          <td>
            The standalone Debian package installs <code>nessie-executor</code> and a systemd user
            service. Enable the paired instance to keep it running after logout; this also enables
            lingering for your user account. A Linux Desktop session can supervise an executor only
            while Desktop runs.
          </td>
          <td>
            The packaged <code>amd64 .deb</code> is the documented headless route. Other distro
            packages and package repositories are planned; there are no RPM, Snap, Flatpak or AUR
            instructions to rely on yet.
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      Look for the platform asset and checksum on the{' '}
      <a href="https://github.com/UnlikeOtherAI/Nessie/releases">Nessie releases page</a>. Use only
      a publisher-verified release. If a release channel has no downloadable asset yet, wait for
      its publication; a local development build is not an executor installer. See{' '}
      <Link to="/docs/executors">remote executors</Link> for their scope and capability model.
    </p>

    <h2>Pair both sides</h2>
    <ol>
      <li>
        On the machine, choose <strong>Pair this Mac</strong> in the Mac menu bar app or{' '}
        <strong>Pair with Nessie</strong> in the Windows tray. On Linux, start pairing with the
        installed CLI. Choose the folder it may
        work with and the production Nessie destination if offered. The machine shows an eight-digit
        code, fingerprint and countdown.
      </li>
      <li>
        Sign in to Nessie and open <strong>Admin › Computers › Pair a computer</strong>. Enter all
        eight digits, including any leading zeroes. Choose the organisation, the correct team from
        the live picker and the access scope. A project&rsquo;s Computers tab opens the same pairing
        flow with that project selected. Do not create a similarly named team to work around a
        missing choice.
      </li>
      <li>
        Compare the machine fingerprint, then choose <strong>Pair machine</strong>. Return to the
        machine: it shows which organisation and team claimed the code. Confirm there only when both
        names match your choice. Entering the code on the website alone does not activate it.
      </li>
      <li>
        Check that the machine says <strong>Paired</strong> and appears <strong>Online</strong> in
        Nessie. Review its proposed capabilities in <strong>Permissions</strong> and give each
        intended agent access in <strong>Agents</strong>. Pairing, capability approval and agent
        access are three separate decisions. Online means the daemon is connected; it does not
        mean an agent is allowed to use it.
      </li>
    </ol>
    <p>
      Codes work once and expire after ten minutes. Cancel an attempt on the machine or request a
      new code if time runs out or the destination is wrong. Closing the website dialog does not
      confirm a pending claim. If this computer is already paired, choose <strong>Replace
      pairing</strong> only when you intend to retire its existing server connection; otherwise
      cancel and keep it. Review permissions and agent access again after replacement.
    </p>
    <p className="n-placeholder">
      Current limitation: activating a capability revision, changing private assignments and
      allowing an agent require fresh local-password verification. Accounts that sign in only
      through UOA SSO cannot complete those access changes yet, so a newly paired machine cannot
      be made usable by agents through an SSO-only account. A new SSO login does not satisfy this
      check. Disconnect and Delete remain available to authorised managers because they only remove
      access.
    </p>

    <h2>Sessions and sharing</h2>
    <p>
      Open <strong>Admin › Computers › Sessions</strong>, an executor&rsquo;s <strong>Sessions</strong> tab,
      or the session link returned by an agent to view live output. <strong>Share session</strong>
      gives named people in your organisation view-only access to that session&rsquo;s screen and
      available scrollback. A URL by itself grants nothing. Viewers cannot type, close or reshare
      the session; remove a viewer in the same dialog to revoke access. Terminal sessions do not
      survive a reboot or a stopped owning daemon.
    </p>

    <h2>Stop, pause or unpair</h2>
    <table>
      <thead><tr><th>Action</th><th>What happens</th><th>How to use it again</th></tr></thead>
      <tbody>
        <tr><td>Stop local daemon</td><td>Connection stops; pairing remains.</td><td>Start its app or service.</td></tr>
        <tr><td>Pause in Nessie</td><td>Server refuses new work.</td><td>Resume after review.</td></tr>
        <tr>
          <td>Disconnect in Nessie</td><td>Revokes pairing; keeps visible history.</td>
          <td>Pair with a new key.</td>
        </tr>
        <tr>
          <td>Delete in Nessie</td><td>Revokes pairing and hides the machine; audit records remain.</td>
          <td>Pair again.</td>
        </tr>
        <tr>
          <td>Uninstall locally</td><td>Removes software, but may retain pairing state.</td>
          <td>Reinstall and inspect state.</td>
        </tr>
      </tbody>
    </table>
    <p>
      To unpair fully, Disconnect or Delete in Nessie first. Then stop the local supervisor, disable
      its startup setting, and uninstall if wanted. Do not remove the machine key before server
      revocation: that can strand the old record and prevent signed replacement.
    </p>

    <h2>When it does not connect</h2>
    <ul>
      <li>
        An expired code needs a fresh attempt on the machine. Check the exact team and destination
        before confirming.
      </li>
      <li>
        For an offline machine, check that its menu bar app, Desktop session or service is running,
        then check outbound HTTPS access and the server status.
      </li>
      <li>
        If the machine is online but an agent cannot use it, check capability review, that
        agent&rsquo;s grants, scope and local policy. SSO-only accounts may encounter the
        fresh-verification limitation above.
      </li>
      <li>
        On Windows, quitting the tray does not stop the service. On Mac, quitting the menu bar app
        does. On Linux, check the systemd user unit and lingering.
      </li>
      <li>
        If a runtime or capability is rejected, use matching server and executor releases. Do not
        bypass a publisher or integrity check.
      </li>
    </ul>
  </>
)
