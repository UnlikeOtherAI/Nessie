let pairingView = null
let pairingOpen = false
let pairingBusy = false

const pairingDestination = (view) => [view.organizationName, view.teamName].filter(Boolean).join(' · ')

const renderPairing = (view) => {
  pairingView = view
  pairingOpen = ['waiting', 'confirmation', 'alreadyPaired', 'expired'].includes(view.status)
  const progress = document.getElementById('pairing-progress')
  progress.hidden = !pairingOpen
  document.getElementById('pair-form').style.display = pairingOpen ? 'none' : ''
  document.getElementById('executors-list').hidden = pairingOpen
  const boxes = document.getElementById('pairing-code')
  boxes.replaceChildren()
  if (view.status === 'waiting') {
    for (const digit of view.code ?? '') {
      const box = document.createElement('span')
      box.textContent = digit
      boxes.append(box)
    }
  }
  document.getElementById('pairing-instruction').textContent = {
    waiting: 'In Nessie, open Agents → Executors, choose Pair executor and enter this code.',
    confirmation: 'Confirm where this computer will connect.',
    alreadyPaired: 'This computer is already paired. Close that pairing and create a new one?',
    expired: 'This code expired. Cancel and get a new code.',
  }[view.status] ?? ''
  document.getElementById('pairing-destination').textContent = pairingDestination(view)
  document.getElementById('pairing-fingerprint').textContent = view.fingerprint
    ? `${view.machineName ?? 'This computer'} · Fingerprint ${view.fingerprint}` : ''
  document.getElementById('pairing-confirm').hidden = view.status !== 'confirmation'
  document.getElementById('pairing-replace').hidden = view.status !== 'alreadyPaired'
  document.getElementById('pairing-stop').textContent = view.status === 'alreadyPaired' ? 'Keep pairing' : 'Cancel'
  updatePairingTime()
}

const updatePairingTime = () => {
  const element = document.getElementById('pairing-time')
  if (!pairingView?.expiresAt || !['waiting', 'confirmation'].includes(pairingView.status)) {
    element.textContent = ''
    return
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(pairingView.expiresAt) - Date.now()) / 1000))
  element.textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  document.getElementById('pairing-confirm').disabled = seconds === 0 || pairingBusy
}

const pairingAction = async (command, args) => {
  if (pairingBusy) return
  pairingBusy = true
  try {
    const view = await window.__TAURI__.core.invoke(command, args)
    renderPairing(view)
    if (view.status === 'paired') {
      await refresh()
      headline.textContent = `Connected to ${pairingDestination(view)}`
    }
  } catch (reason) {
    document.getElementById('headline').textContent = String(reason)
    document.getElementById('dot').dataset.state = 'attention'
  } finally {
    pairingBusy = false
    updatePairingTime()
  }
}

const restorePairing = async () => {
  try {
    const view = await window.__TAURI__.core.invoke('executor_pairing_status')
    renderPairing(view)
  } catch {
    pairingView = null
    // Service status owns the displayed refusal, including the signing gate.
  }
}

const openPairForm = async () => {
  showList()
  if (pairingView?.status === 'paired') {
    renderPairing({ ...pairingView, status: 'alreadyPaired' })
    return
  }
  document.getElementById('pair-form').style.display = 'block'
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pair').onclick = openPairForm
  document.getElementById('pair-cancel').onclick = () => {
    document.getElementById('pair-form').style.display = 'none'
  }
  document.getElementById('choose-workspace').onclick = async () => {
    const selected = await window.__TAURI__.core.invoke('executor_choose_folder')
    if (selected) {
      chosenWorkspace = selected
      document.getElementById('chosen-workspace').textContent = selected
    }
  }
  const start = async (replace) => {
    if (!chosenWorkspace) {
      chosenWorkspace = await window.__TAURI__.core.invoke('executor_choose_folder')
      if (!chosenWorkspace) return
    }
    await pairingAction('executor_pairing_start', { workspaceRoot: chosenWorkspace, replace })
  }
  document.getElementById('pair-form').onsubmit = async (event) => { event.preventDefault(); await start(false) }
  document.getElementById('pairing-replace').onclick = () => start(true)
  document.getElementById('pairing-confirm').onclick = () => pairingAction('executor_pairing_confirm', {
    claimDigest: pairingView.claimDigest,
  })
  document.getElementById('pairing-stop').onclick = async () => {
    if (pairingView?.status === 'alreadyPaired') {
      renderPairing({ ...pairingView, status: 'paired' })
      return refresh()
    }
    await pairingAction('executor_pairing_cancel')
    await refresh()
  }
  document.getElementById('open-nessie').onclick = () => window.__TAURI__.core.invoke('executor_open_nessie', {
    apiBaseUrl: pairingView?.apiBaseUrl ?? 'nessie',
  })
  setInterval(updatePairingTime, 1000)
  setInterval(() => { if (!pairingBusy && !pairingOpen) restorePairing() }, 60000)
  setInterval(() => {
    if (!pairingBusy && ['waiting', 'confirmation'].includes(pairingView?.status)) {
      pairingAction('executor_pairing_status')
    }
  }, 3000)
})
