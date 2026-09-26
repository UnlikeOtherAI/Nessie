const { invoke, listen } = window.executorNative
const byId = (id) => document.getElementById(id)
let connections = []
let currentExecutorId = null
let description = null
let currentTab = 'teams'
let busy = false
const connectionNames = new Map()
const connectionLabel = (connection) => [connection?.organizationName, connection?.teamName].filter(Boolean).join(' / ')
const reportError = (error) => { byId('error').textContent = String(error); byId('error').hidden = false }

const act = async (action) => {
  if (busy) return
  busy = true
  byId('error').hidden = true
  byId('saved').textContent = ''
  document.body.inert = true
  try { return await action() } catch (error) { reportError(error) } finally {
    busy = false
    document.body.inert = false
  }
}

const showTab = async (tab) => {
  currentTab = tab
  for (const button of document.querySelectorAll('[data-tab]')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
    byId(`tab-${button.dataset.tab}`).hidden = button.dataset.tab !== tab
  }
  const needsConnection = ['folders', 'commands'].includes(tab)
  byId('connection-picker').hidden = !needsConnection
  if (needsConnection) {
    if (!currentExecutorId) { reportError('Pair a team first to configure its permissions.'); return }
    await loadDescription()
  }
}

const renderConnections = () => {
  const list = byId('executors-list')
  list.replaceChildren()
  const select = byId('connection')
  select.replaceChildren()
  if (!connections.length) {
    const empty = document.createElement('p')
    empty.textContent = 'No teams paired yet. Add a team to get your pairing code.'
    list.append(empty)
  }
  for (const connection of connections) {
    const identity = connectionNames.get(connection.executorId)
    const label = connectionLabel(identity) || `Connection ${connection.executorId.slice(0, 8)}`
    const option = document.createElement('option')
    option.value = connection.executorId
    option.textContent = `${label} · ${identity?.apiBaseUrl ?? connection.executorId.slice(0, 8)}`
    select.append(option)
    const row = document.createElement('div')
    row.className = 'connection-row'
    const name = document.createElement('div')
    name.className = 'connection-name'
    name.textContent = label
    const details = document.createElement('small')
    details.textContent = `${connection.daemonStatus} · ${identity?.apiBaseUrl ?? 'Checking team…'}`
    name.append(details)
    const running = ['running', 'starting'].includes(connection.daemonStatus)
    const toggle = document.createElement('button')
    toggle.textContent = running ? 'Stop' : 'Start'
    toggle.onclick = () => act(async () => {
      await invoke(running ? 'executor_stop' : 'executor_start', { executorId: connection.executorId })
      await refresh()
    })
    const settings = document.createElement('button')
    settings.textContent = 'Permissions'
    settings.onclick = () => act(async () => { currentExecutorId = connection.executorId; await showTab('folders') })
    row.append(name, toggle, settings)
    list.append(row)
  }
  if (!connections.some((connection) => connection.executorId === currentExecutorId)) {
    currentExecutorId = connections[0]?.executorId ?? null
    description = null
  }
  select.value = currentExecutorId ?? ''
}

const refresh = async () => {
  const view = await invoke('executor_view')
  if (view.kind !== 'reachable') throw new Error(view.reason)
  connections = view.executors
  byId('headline').textContent = connections.length
    ? `${connections.filter((item) => item.daemonStatus === 'running').length} of ${connections.length} team connections running`
    : 'Ready to pair this computer'
  for (const connection of connections) {
    if (!connectionNames.has(connection.executorId)) {
      try { connectionNames.set(connection.executorId, await invoke('executor_pairing_status', { executorId: connection.executorId })) }
      catch { /* Preserve the local connection row when its server is offline. */ }
    }
  }
  renderConnections()
}

const loadDescription = async () => {
  description = null
  const id = currentExecutorId
  const next = await invoke('executor_describe', { executorId: id })
  if (id !== currentExecutorId) return
  description = next
  renderPermissions(next)
}

const saveConfiguration = async (changes) => {
  if (!description || description.executorId !== currentExecutorId) throw new Error('Select a paired team first.')
  description = await invoke('executor_configure', {
    executorId: currentExecutorId,
    configurationInput: { operationKeys: description.policy.operations, workspaceFolders: description.reach.folders, ...changes },
  })
  renderPermissions(description)
  byId('saved').textContent = 'Saved on this computer.'
}

for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => act(() => showTab(button.dataset.tab))
byId('connection').onchange = () => act(async () => { currentExecutorId = byId('connection').value; await loadDescription() })
byId('hide').onclick = () => invoke('executor_hide_status').catch(reportError)
byId('open-nessie').onclick = () => invoke('executor_open_nessie', {
  apiBaseUrl: connectionNames.get(currentExecutorId)?.apiBaseUrl ?? 'nessie',
}).catch(reportError)
const navigate = async (action) => {
  while (busy) await new Promise((finish) => setTimeout(finish, 50))
  await act(action)
}
for (const [event, tab] of [['teams', 'teams'], ['settings', 'settings'], ['reach', 'folders'], ['tools', 'commands']]) {
  listen(`tray://section/${event}`, () => navigate(() => showTab(tab)))
}
listen('tray://pair', () => navigate(openPairForm))
window.addEventListener('DOMContentLoaded', () => {
  act(async () => {
    for (const load of [refresh, restorePairing, loadAutostart]) {
      try { await load() } catch (error) { reportError(error) }
    }
  })
  setInterval(() => { if (!busy) refresh().catch(reportError) }, 5000)
})
