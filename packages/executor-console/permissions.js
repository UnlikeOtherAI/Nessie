let terminalFolder = null
const lines = (id) => byId(id).value.split('\n').map((line) => line.trim()).filter(Boolean)

const renderPermissions = (value) => {
  byId('existing-coding-sessions').checked = value.existingCodingSessionsEnabled !== false
  const folders = byId('reach-folders')
  folders.replaceChildren()
  for (const folder of value.reach.folders) {
    const row = document.createElement('div')
    row.className = 'folder-row'
    const name = document.createElement('div')
    name.className = 'folder-name'
    name.textContent = folder.name
    const path = document.createElement('small')
    path.textContent = folder.path
    name.append(path)
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.onclick = () => act(() => saveConfiguration({
      workspaceFolders: value.reach.folders.filter((entry) => entry.name !== folder.name),
    }))
    row.append(name, remove)
    folders.append(row)
  }
  const policy = value.commandPolicy
  byId('command-mode').value = policy.mode
  byId('command-allowlist').value = policy.allowlist.join('\n')
  byId('command-denylist').value = policy.denylist.join('\n')
  byId('command-allowlist').disabled = policy.mode === 'all'
  byId('command-availability').textContent = value.policy.operations.includes('command.run')
    ? 'Command execution is available. Permission changes take effect when the local connection restarts.'
    : 'Command rules are saved locally. Sandboxed command execution requires a configured guest runtime; interactive programs below use the local terminal.'
  byId('terminal-current').textContent = value.policy.codingSessions?.agents.includes('terminal')
    ? `Interactive mode is enabled for: ${value.policy.codingSessions.rootNames.join(', ')}.`
    : 'No interactive program configured for this team yet.'
  terminalFolder = null
  byId('terminal-folder').textContent = 'No folder chosen'
  byId('terminal-command').value = ''
  byId('terminal-arguments').value = ''
}

byId('add-folder').onclick = () => act(async () => {
  if (!description) throw new Error('Select a paired team first.')
  const path = await invoke('executor_choose_folder')
  if (!path) return
  // Native/runtime validation owns path, overlap and name rules.
  let index = 1
  while (description.reach.folders.some((folder) => folder.name === `folder-${index}`)) index += 1
  await saveConfiguration({ workspaceFolders: [...description.reach.folders, { name: `folder-${index}`, path }] })
})
byId('command-mode').onchange = () => { byId('command-allowlist').disabled = byId('command-mode').value === 'all' }
byId('command-form').onsubmit = (event) => {
  event.preventDefault()
  act(() => saveConfiguration({ commandPolicy: {
    mode: byId('command-mode').value, allowlist: lines('command-allowlist'), denylist: lines('command-denylist'),
  } }))
}
byId('choose-terminal-folder').onclick = () => act(async () => {
  const folder = await invoke('executor_choose_folder')
  if (folder) { terminalFolder = folder; byId('terminal-folder').textContent = folder }
})
byId('terminal-form').onsubmit = (event) => {
  event.preventDefault()
  act(async () => {
    if (!terminalFolder) throw new Error('Choose the working folder for this interactive program.')
    const program = byId('terminal-command').value.trim()
    if (!program) throw new Error('Enter the installed program’s name or full executable path.')
    const command = [program, ...lines('terminal-arguments')]
    await saveConfiguration({ terminalProgram: { command, workspaceRoot: terminalFolder } })
  })
}

const loadAutostart = async () => {
  const setting = await invoke('executor_autostart')
  byId('autostart').checked = setting.enabled
  byId('autostart-note').textContent = setting.note
}
byId('autostart').onchange = () => act(async () => {
  try { await invoke('executor_set_autostart', { enabled: byId('autostart').checked }) }
  finally { await loadAutostart() }
})

byId('existing-coding-sessions').onchange = () => act(() => saveConfiguration({
  existingCodingSessionsEnabled: byId('existing-coding-sessions').checked,
}))
