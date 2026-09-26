let pairingView = null
let chosenWorkspace = null
let pairingPolling = false

const renderPairing = (view) => {
  pairingView = view
  const open = ['waiting', 'confirmation', 'expired'].includes(view.status)
  byId('pairing-progress').hidden = !open
  if (open) byId('pair-form').hidden = true
  byId('pairing-code').textContent = view.status === 'waiting' ? view.code ?? '' : ''
  byId('code-row').hidden = view.status !== 'waiting'
  byId('copy-code').textContent = 'Copy'
  byId('pairing-title').textContent = view.status === 'confirmation' ? 'Confirm this team' : 'Pair this computer'
  byId('pairing-instruction').textContent = {
    waiting: 'In Nessie, select your team, then open Admin › Computers › Pair a computer and paste this code.',
    confirmation: 'Connect only if this is the organisation and team you selected in Nessie.',
    expired: 'This code expired. Cancel this attempt, then get a new code.',
  }[view.status] ?? ''
  byId('pairing-destination').textContent = view.status === 'confirmation' ? connectionLabel(view) : ''
  byId('pairing-fingerprint').textContent = view.fingerprint ? `${view.machineName ?? 'This computer'} · ${view.fingerprint}` : ''
  byId('pairing-confirm').hidden = view.status !== 'confirmation'
  updatePairingTime()
}

const updatePairingTime = () => {
  if (!pairingView?.expiresAt) { byId('pairing-time').textContent = ''; return }
  const seconds = Math.max(0, Math.ceil((Date.parse(pairingView.expiresAt) - Date.now()) / 1000))
  byId('pairing-time').textContent = seconds
    ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Code expired — request a new code.'
  byId('pairing-confirm').disabled = busy || seconds === 0
  byId('copy-code').disabled = busy || seconds === 0
}

const restorePairing = async () => {
  const view = await invoke('executor_pairing_status')
  renderPairing(view)
  if (view.status === 'paired') await refresh()
}

const openPairForm = async () => {
  await showTab('teams')
  if (['waiting', 'confirmation'].includes(pairingView?.status)) return
  byId('pairing-progress').hidden = true
  byId('pair-form').hidden = false
  byId('pairing-server').focus()
}

byId('pair').onclick = () => act(openPairForm)
byId('pair-cancel').onclick = () => { byId('pair-form').hidden = true }
byId('choose-workspace').onclick = () => act(async () => {
  const selected = await invoke('executor_choose_folder')
  if (selected) { chosenWorkspace = selected; byId('chosen-workspace').textContent = selected }
})
byId('pair-form').onsubmit = (event) => {
  event.preventDefault()
  act(async () => {
    if (!chosenWorkspace) chosenWorkspace = await invoke('executor_choose_folder')
    if (!chosenWorkspace) return
    renderPairing(await invoke('executor_pairing_start', {
      workspaceRoot: chosenWorkspace, replace: false, apiBaseUrl: byId('pairing-server').value,
    }))
  })
}
byId('copy-code').onclick = () => act(async () => {
  if (pairingView?.status !== 'waiting' || Date.parse(pairingView.expiresAt) <= Date.now()) return
  await invoke('executor_copy_code', { code: pairingView.code })
  byId('copy-code').textContent = 'Copied'
})
byId('pairing-confirm').onclick = () => act(async () => {
  const displayed = pairingView
  if (displayed?.status !== 'confirmation' || Date.parse(displayed.expiresAt) <= Date.now()) return
  renderPairing(await invoke('executor_pairing_confirm', { claimDigest: displayed.claimDigest }))
  await refresh()
})
byId('pairing-stop').onclick = () => act(async () => {
  renderPairing(await invoke('executor_pairing_cancel'))
  await refresh()
})
setInterval(updatePairingTime, 1000)
setInterval(async () => {
  if (busy || pairingPolling || !['waiting', 'confirmation'].includes(pairingView?.status)) return
  pairingPolling = true
  try { await restorePairing() } catch (error) { reportError(error) } finally { pairingPolling = false }
}, 3000)
