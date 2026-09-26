# Install and run the executor

The executor connects a computer you control to Nessie. Install it under the OS
account whose files and programs it should use. You do not need Node.js or a
source checkout.

## macOS

The CLI requires macOS 15 or later on Apple Silicon:

```sh
brew install unlikeotherai/tap/nessie-executor
```

For the full Nessie desktop app, or the standalone executor with its local
permissions window:

```sh
brew install --cask unlikeotherai/tap/nessie
brew install --cask unlikeotherai/tap/nessie-executor-app
```

Choose the interface you want to use. Run one supervisor for each pairing.
In the executor app, **Settings → Open Nessie Executor when I log in**
controls automatic startup.

## Debian and Ubuntu

Use the signed APT repository on x86_64 Debian 12+ or Ubuntu 22.04+:

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.nessie.works/nessie-executor.asc | sudo tee /etc/apt/keyrings/nessie-executor.asc >/dev/null
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/nessie-executor.asc] https://packages.nessie.works/apt stable main" | sudo tee /etc/apt/sources.list.d/nessie-executor.list >/dev/null
sudo apt-get update
sudo apt-get install nessie-executor
```

## Fedora, Rocky Linux and AlmaLinux

Use the signed RPM repository on x86_64 Fedora or Rocky Linux / AlmaLinux 9+:

```sh
sudo curl -fsSL https://packages.nessie.works/nessie-executor.repo -o /etc/yum.repos.d/nessie-executor.repo
sudo dnf install nessie-executor
```

Linux background services require systemd. The packages include the runtime;
APT or DNF installs Git and tmux as dependencies.

## Windows executor

Install the signed standalone executor using WinGet:

```powershell
winget install --exact --id UnlikeOtherAI.NessieExecutor
```

Open **Nessie Executor** from Start or the tray. New team connections run as
your signed-in Windows account. The installer also provides the independent
service-account supervisor. Personal interactive programs belong in a
user-session connection, where their login credentials are available.

## Pair a team

Run the CLI as your ordinary account, without sudo:

```sh
nessie-executor login --api nessie --workspace "/path/to/work"
```

For your own Nessie server, replace `nessie` with its HTTPS API URL.
The desktop executor's **Add team** starts the same flow.

1. Copy the eight-digit code shown on the computer.
2. In Nessie, open **Agents → Executors → Add executor**. Paste the code,
   select the organisation, team and access scope, and review the fingerprint.
3. Confirm the claimed organisation and team on the computer.
4. Check that the executor is online, review its capabilities in Nessie and
   grant the intended agents access.

Codes expire after ten minutes and work once. Repeat `login` or **Add team**
to pair another team. Each connection has its own machine key, folders,
command rules and startup service.

```sh
nessie-executor teams
nessie-executor permissions --executor <executor-id>
nessie-executor permissions --executor <executor-id> --allow-all --deny "git push *"
nessie-executor permissions --executor <executor-id> --allow "git *,pnpm *"
```

All commands are allowed by default, subject to structural safety checks;
the local denylist wins over the allowlist. Folder and command permissions are
stored only on this computer and cannot be changed through Nessie. Nessie
controls which people and agents may use the connection within its team.
Stop the local daemon before changing permissions, then start it again.

Codex, Gemini, Claude and other interactive programs must already be installed
and signed in under the same account. Configure their executable and working
folder locally. An interactive program has the OS account's access; its working
folder is not a sandbox. Sandboxed `command.run` separately requires the
[guest runtime](../executor-protocol/sandbox-forced-egress-and-credentials.md).

## Startup, status and updates

Interactive `login` enables automatic startup after you confirm pairing. On macOS, a
launchd agent starts that team when you log in. On Linux, a systemd user
service and lingering keep it connected across logout and reboot.

```sh
nessie-executor status
nessie-executor enable <executor-id>
nessie-executor disable <executor-id>
```

`disable` stops the service without deleting its pairing or permissions.
For a foreground session, disable its service first, then use
`nessie-executor daemon --executor <executor-id>`.
Pairings created with an explicit `--state-dir` use foreground supervision.

Mac CLI logs are in `~/Library/Logs/NessieExecutor/<executor-id>.log`.
Linux logs are available with
`journalctl --user -u nessie-executor@<executor-id>`.

Upgrade with your package manager:

```sh
brew upgrade nessie-executor
sudo apt-get update && sudo apt-get install --only-upgrade nessie-executor
sudo dnf upgrade nessie-executor
```

On Windows, use `winget upgrade --exact --id UnlikeOtherAI.NessieExecutor`.
Restart each CLI service with `disable` followed by `enable` after upgrading.
CLI pairing keys and local permissions live at
`~/.local/state/nessie-executor/`. Desktop apps keep their state in the account's
application data directory. Both are outside the installed package, so upgrades
preserve them.

To remove the software, disable every CLI service or turn off the app's login
setting and quit it, then uninstall through the same package manager.
Uninstalling preserves pairing state. **Disconnect** or **Delete** the executor
in Nessie to revoke access; deleting local files alone does not revoke the
server record.

For local configuration details, see [local controls](../executor-local-controls.md).
For release operators, see [package distribution](../releasing-executor-packages.md).
