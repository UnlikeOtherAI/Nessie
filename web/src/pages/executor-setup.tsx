export const ExecutorSetupPage = () => (
  <>
    <p>
      {"The executor connects a computer you control to Nessie. Install it under the OS "}
      {"account whose files and programs it should use. You do not need Node.js or a "}
      {"source checkout."}
    </p>

    <h2>macOS</h2>

    <p>
      {"The CLI requires macOS 15 or later on Apple Silicon:"}
    </p>

    <pre><code>{"brew install unlikeotherai/tap/nessie-executor"}</code></pre>

    <p>
      {"For the full Nessie desktop app, or the standalone executor with its local "}
      {"permissions window:"}
    </p>

    <pre><code>{`brew install --cask unlikeotherai/tap/nessie
brew install --cask unlikeotherai/tap/nessie-executor-app`}</code></pre>

    <p>
      {"Choose the interface you want to use. Run one supervisor for each pairing. "}
      {"In the executor app, "}<strong>Settings → Open Nessie Executor when I log in</strong>{" "}
      {"controls automatic startup."}
    </p>

    <h2>Debian and Ubuntu</h2>

    <p>
      {"Use the signed APT repository on x86_64 Debian 12+ or Ubuntu 22.04+:"}
    </p>

    <pre><code>{`sudo apt-get update
sudo apt-get install -y curl ca-certificates
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.nessie.works/nessie-executor.asc | sudo tee /etc/apt/keyrings/nessie-executor.asc >/dev/null
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/nessie-executor.asc] https://packages.nessie.works/apt stable main" | sudo tee /etc/apt/sources.list.d/nessie-executor.list >/dev/null
sudo apt-get update
sudo apt-get install nessie-executor`}</code></pre>

    <h2>Fedora, Rocky Linux and AlmaLinux</h2>

    <p>
      {"Use the signed RPM repository on x86_64 Fedora or Rocky Linux / AlmaLinux 9+:"}
    </p>

    <pre><code>{`sudo curl -fsSL https://packages.nessie.works/nessie-executor.repo -o /etc/yum.repos.d/nessie-executor.repo
sudo dnf install nessie-executor`}</code></pre>

    <p>
      {"Linux background services require systemd. The packages include the runtime; "}
      {"APT or DNF installs Git and tmux as dependencies."}
    </p>

    <h2>Windows executor</h2>

    <p>
      {"Install the signed standalone executor using WinGet:"}
    </p>

    <pre><code>{"winget install --exact --id UnlikeOtherAI.NessieExecutor"}</code></pre>

    <p>
      {"Open "}<strong>Nessie Executor</strong>{" from Start or the tray. New team connections run as "}
      {"your signed-in Windows account. The installer also provides the independent "}
      {"service-account supervisor. Personal interactive programs belong in a "}
      {"user-session connection, where their login credentials are available."}
    </p>

    <h2>Pair a team</h2>

    <p>
      {"Run the CLI as your ordinary account, without sudo:"}
    </p>

    <pre><code>{"nessie-executor login --api nessie --workspace \"/path/to/work\""}</code></pre>

    <p>
      {"For your own Nessie server, replace "}<code>{"nessie"}</code>{" with its HTTPS API URL. "}
      {"The desktop executor's "}<strong>Add team</strong>{" starts the same flow."}
    </p>

    <ol>

      <li>
        {"Copy the eight-digit code shown on the computer."}
      </li>

      <li>
        {"In Nessie, open "}<strong>Agents → Executors → Add executor</strong>{". Paste the code,"}
        {"   select the organisation, team and access scope, and review the fingerprint."}
      </li>

      <li>
        {"Confirm the claimed organisation and team on the computer."}
      </li>

      <li>
        {"Check that the executor is online, review its capabilities in Nessie and"}
        {"   grant the intended agents access."}
      </li>

    </ol>

    <p>
      {"Codes expire after ten minutes and work once. Repeat "}<code>{"login"}</code>{" or "}<strong>Add team</strong>{" "}
      {"to pair another team. Each connection has its own machine key, folders, "}
      {"command rules and startup service."}
    </p>

    <pre><code>{`nessie-executor teams
nessie-executor permissions --executor <executor-id>
nessie-executor permissions --executor <executor-id> --allow-all --deny "git push *"
nessie-executor permissions --executor <executor-id> --allow "git *,pnpm *"`}</code></pre>

    <p>
      {"All commands are allowed by default, subject to structural safety checks; "}
      {"the local denylist wins over the allowlist. Folder and command permissions are "}
      {"stored only on this computer and cannot be changed through Nessie. Nessie "}
      {"controls which people and agents may use the connection within its team. "}
      {"Stop the local daemon before changing permissions, then start it again."}
    </p>

    <p>
      {"Codex, Gemini, Claude and other interactive programs must already be installed "}
      {"and signed in under the same account. Configure their executable and working "}
      {"folder locally. An interactive program has the OS account's access; its working "}
      {"folder is not a sandbox. Sandboxed "}<code>{"command.run"}</code>{" separately requires the "}
      <a href="/docs/executors">guest runtime</a>{"."}
    </p>

    <h2>Startup, status and updates</h2>

    <p>
      {"Interactive "}<code>{"login"}</code>{" enables automatic startup after you confirm pairing. On macOS, a "}
      {"launchd agent starts that team when you log in. On Linux, a systemd user "}
      {"service and lingering keep it connected across logout and reboot."}
    </p>

    <pre><code>{`nessie-executor status
nessie-executor enable <executor-id>
nessie-executor disable <executor-id>`}</code></pre>

    <p>
      <code>{"disable"}</code>{" stops the service without deleting its pairing or permissions. "}
      {"For a foreground session, disable its service first, then use "}
      <code>{"nessie-executor daemon --executor <executor-id>"}</code>{". "}
      {"Pairings created with an explicit "}<code>{"--state-dir"}</code>{" use foreground supervision."}
    </p>

    <p>
      {"Mac CLI logs are in "}<code>{"~/Library/Logs/NessieExecutor/<executor-id>.log"}</code>{". "}
      {"Linux logs are available with "}
      <code>{"journalctl --user -u nessie-executor@<executor-id>"}</code>{"."}
    </p>

    <p>
      {"Upgrade with your package manager:"}
    </p>

    <pre><code>{`brew upgrade nessie-executor
sudo apt-get update && sudo apt-get install --only-upgrade nessie-executor
sudo dnf upgrade nessie-executor`}</code></pre>

    <p>
      {"On Windows, use "}<code>{"winget upgrade --exact --id UnlikeOtherAI.NessieExecutor"}</code>{". "}
      {"Restart each CLI service with "}<code>{"disable"}</code>{" followed by "}<code>{"enable"}</code>{" after upgrading. "}
      {"CLI pairing keys and local permissions live at "}
      <code>{"~/.local/state/nessie-executor/"}</code>{". Desktop apps keep their state in the account's "}
      {"application data directory. Both are outside the installed package, so upgrades preserve them."}
    </p>

    <p>
      {"To remove the software, disable every CLI service or turn off the app's login "}
      {"setting and quit it, then uninstall through the same package manager. "}
      {"Uninstalling preserves pairing state. "}<strong>Disconnect</strong>{" or "}<strong>Delete</strong>{" the executor "}
      {"in Nessie to revoke access; deleting local files alone does not revoke the "}
      {"server record."}
    </p>

    <p>
      {"For local configuration details, see "}<a href="/docs/executors">local controls</a>{"."}
    </p>
  </>
)
