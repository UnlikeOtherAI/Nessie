const invoke = window.__TAURI__.core.invoke
const event = window.__TAURI__.event
const dot = document.getElementById('dot')
const headline = document.getElementById('headline')
const listPanel = document.getElementById('list-panel')
const detailPanel = document.getElementById('detail-panel')
const executorsList = document.getElementById('executors-list')
const pairForm = document.getElementById('pair-form')
const chosenWorkspaceLabel = document.getElementById('chosen-workspace')
const chooseWorkspaceButton = document.getElementById('choose-workspace')
let busy = false
let currentView = null
let currentExecutorId = null
let currentTab = 'settings'
let chosenWorkspace = null
let pendingFingerprint = null

const trayState = (view) => {
  if (view.kind !== 'reachable') return 'error'
  if (view.executors.some((e) => ['starting', 'stopping', 'awaiting_confirmation'].includes(e.daemonStatus))) {
    return 'attention'
  }
  return view.executors.some((e) => e.daemonStatus === 'running') ? 'running' : 'idle'
}

const headlineFor = (view) => {
  if (view.kind !== 'reachable') return `Nessie Executor — ${view.reason}`
  if (view.executors.length === 0) return 'Nessie Executor — nothing paired'
  const running = view.executors.filter((e) => e.daemonStatus === 'running').length
  return `Nessie Executor — ${running} of ${view.executors.length} running`
}

const renderList = (view) => {
  executorsList.replaceChildren()
  if (view.kind !== 'reachable') {
    pairForm.style.display = 'none'
    const problem = document.createElement('p')
    problem.className = 'problem'
    problem.textContent = view.reason
    executorsList.append(problem)
    return
  }
  if (view.executors.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No executor is paired on this computer yet.'
    executorsList.append(empty)
    pairForm.style.display = 'flex'
    pairForm.style.flexDirection = 'column'
    return
  }
  pairForm.style.display = 'none'
  for (const executor of view.executors) {
    const row = document.createElement('div')
    row.className = 'row'
    const id = document.createElement('span')
    id.className = 'id'
    id.textContent = pairingView?.machineName ?? 'This computer'
    const state = document.createElement('span')
    state.className = 'state'
    state.textContent = executor.daemonStatus
    const start = document.createElement('button')
    start.textContent = 'Start'
    start.disabled = busy || ['running', 'starting'].includes(executor.daemonStatus)
    start.onclick = () => act('executor_start', { executorId: executor.executorId })
    const stop = document.createElement('button')
    stop.textContent = 'Stop'
    stop.disabled = busy || !['running', 'starting'].includes(executor.daemonStatus)
    stop.onclick = () => act('executor_stop', { executorId: executor.executorId })
    const settings = document.createElement('button')
    settings.textContent = 'Settings…'
    settings.disabled = busy
    settings.onclick = () => showDetail(executor.executorId, 'settings')
    row.append(id, state, start, stop, settings)
    executorsList.append(row)
  }
}

const render = (view) => {
  currentView = view
  dot.dataset.state = trayState(view)
  headline.textContent = headlineFor(view)
  if (detailPanel.dataset.open !== 'true' && !pairingOpen) {
    renderList(view)
  }
}

const refresh = async () => {
  render(await invoke('executor_view'))
}

const act = async (command, args) => {
  if (busy) return
  busy = true
  let refused = false
  try {
    const result = await invoke(command, args)
    if (command === 'executor_start' || command === 'executor_stop') {
      render(result)
    } else if (command === 'executor_pair') {
      pendingFingerprint = result.fingerprint
      render(result.view)
      showList()
    } else if (['executor_describe','executor_add_folder','executor_remove_folder','executor_add_command','executor_remove_command'].includes(command)) {
      renderDetail(result)
    }
  } catch (reason) {
    refused = true
    headline.textContent = String(reason)
    dot.dataset.state = 'attention'
  } finally {
    busy = false
    if (!refused && command !== 'executor_pair') await refresh()
  }
}

const showList = () => {
  detailPanel.dataset.open = 'false'
  listPanel.dataset.open = 'true'
  document.getElementById('back').style.display = 'none'
  if (currentView) renderList(currentView)
}

const showDetail = async (executorId, tab) => {
  currentExecutorId = executorId
  currentTab = tab || 'settings'
  listPanel.dataset.open = 'false'
  detailPanel.dataset.open = 'true'
  document.getElementById('back').style.display = 'inline-block'
  updateTabs()
  await act('executor_describe', { executorId })
}

const updateTabs = () => {
  for (const button of document.querySelectorAll('.tab-button')) {
    button.classList.toggle('active', button.dataset.tab === currentTab)
  }
  for (const content of document.querySelectorAll('.tab-content')) {
    content.dataset.open = (content.id === `tab-${currentTab}`).toString()
  }
}

const renderDetail = (description) => {
  document.getElementById('detail-executor').textContent = `Executor ${description.shortExecutorId}`
  document.getElementById('setting-executor-id').textContent = description.executorId
  document.getElementById('setting-organisation').textContent = pairingView?.organizationName ?? 'Nessie'
  document.getElementById('setting-team').textContent = pairingView?.teamName ?? 'No team'
  const revision = document.getElementById('setting-revision')
  revision.textContent = `Local policy is at revision ${description.policy.revision}. Saving a change writes revision ${description.policy.revision + 1} and submits it when the daemon next connects. It takes effect only after a person reviews it in Nessie.`
  const fingerprintBanner = document.getElementById('fingerprint-banner')
  if (pendingFingerprint && description.executorId === currentExecutorId) {
    document.getElementById('setting-fingerprint').textContent = pendingFingerprint
    fingerprintBanner.style.display = 'block'
  } else {
    fingerprintBanner.style.display = 'none'
  }

  const foldersContainer = document.getElementById('reach-folders')
  foldersContainer.replaceChildren()
  if (description.reach.folders.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No folders are configured.'
    foldersContainer.append(empty)
  }
  for (const folder of description.reach.folders) {
    const item = document.createElement('div')
    item.className = 'list-item'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = folder.name
    const path = document.createElement('span')
    path.className = 'path'
    path.textContent = folder.path
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.disabled = busy
    remove.onclick = () => act('executor_remove_folder', { executorId: description.executorId, name: folder.name })
    item.append(name, path, remove)
    foldersContainer.append(item)
  }

  const originsContainer = document.getElementById('reach-origins')
  originsContainer.replaceChildren()
  if (description.reach.allowedOrigins.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = description.sandbox.browserConfigured
      ? 'No origin is allowed, so the guest browser can open nothing.'
      : 'No guest browser is configured, so there is nothing to reach and browser operations cannot be enabled.'
    originsContainer.append(empty)
  }
  for (const origin of description.reach.allowedOrigins) {
    const div = document.createElement('div')
    div.className = 'mono'
    div.textContent = origin
    originsContainer.append(div)
  }
  const reachNotes = document.getElementById('reach-notes')
  reachNotes.textContent = `${description.guestSessionNote} ${description.sandbox.promotionHelperConfigured ? 'A promotion helper is configured: reviewed changes can be written back to these folders.' : 'No promotion helper is configured. Writes land in daemon-owned copy-on-write scratch and nothing is written back to these folders.'}`

  const commandsContainer = document.getElementById('tools-commands')
  commandsContainer.replaceChildren()
  if (description.policy.permittedPrograms.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No command is permitted, so nothing may start.'
    commandsContainer.append(empty)
  }
  for (const program of description.policy.permittedPrograms) {
    const item = document.createElement('div')
    item.className = 'list-item'
    const name = document.createElement('span')
    name.className = 'mono'
    name.textContent = program
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.disabled = busy
    remove.onclick = () => act('executor_remove_command', { executorId: description.executorId, command: program })
    item.append(name, document.createElement('div'), remove)
    commandsContainer.append(item)
  }
  document.getElementById('tools-note').textContent = description.commandRunEnabled
    ? 'command.run is enabled for this executor, so the list must always name at least one command.'
    : 'command.run is not enabled for this executor. These commands take effect when somebody enables it in Nessie.'
  document.getElementById('tools-grammar').textContent = 'A permitted command is a program the guest resolves through its fixed PATH, optionally followed by arguments and a trailing "*" — for example "git *" or "npm run *". Paths, shells and a leading "*" are refused, at most 64 entries.'
}

// Tab switching
for (const button of document.querySelectorAll('.tab-button')) {
  button.onclick = () => {
    currentTab = button.dataset.tab
    updateTabs()
  }
}

// Pair form
document.getElementById('open-logs').onclick = () =>
  invoke('executor_open_logs').catch((reason) => {
    headline.textContent = String(reason)
    dot.dataset.state = 'attention'
  })
document.getElementById('hide').onclick = () => invoke('executor_hide_status')
document.getElementById('back').onclick = showList

document.getElementById('add-folder').onclick = async () => {
  const selected = await invoke('executor_choose_folder')
  if (selected && currentExecutorId) {
    await act('executor_add_folder', { executorId: currentExecutorId, path: selected })
  }
}

document.getElementById('add-command').onclick = async () => {
  const input = document.getElementById('new-command')
  if (!input.value.trim() || !currentExecutorId) return
  await act('executor_add_command', { executorId: currentExecutorId, command: input.value })
  input.value = ''
}

// Menu events
event.listen('tray://pair', openPairForm)
event.listen('tray://section/settings', () => {
  const first = currentView?.kind === 'reachable' ? currentView.executors[0] : null
  if (first) showDetail(first.executorId, 'settings')
  else openPairForm()
})
event.listen('tray://section/reach', () => {
  const first = currentView?.kind === 'reachable' ? currentView.executors[0] : null
  if (first) showDetail(first.executorId, 'reach')
})
event.listen('tray://section/tools', () => {
  const first = currentView?.kind === 'reachable' ? currentView.executors[0] : null
  if (first) showDetail(first.executorId, 'tools')
})

refresh().then(restorePairing)
setInterval(refresh, 3000)
