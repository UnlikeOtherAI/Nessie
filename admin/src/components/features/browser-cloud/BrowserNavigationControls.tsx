import { BROWSER_VIEWPORT_PRESETS, type BrowserViewport } from '@nessie/schemas'

type BrowserTab = { id: string; title: string; url: string }

type BrowserNavigationControlsProps = {
  address: string
  canDrive: boolean
  homePending: boolean
  onAddressBlur: () => void
  onAddressChange: (address: string) => void
  onAddressFocus: () => void
  onBack: () => void
  onForward: () => void
  onHome: () => void
  onNavigate: () => void
  onReload: () => void
  onSwitchTab: (targetId: string) => void
  onViewport: (viewport: BrowserViewport) => void
  presetId: string | null
  tabs: BrowserTab[]
  viewport: BrowserViewport | null
  viewportDisabled: boolean
}

/** Full-screen browser controls; the panel keeps its preview compact. */
export const BrowserNavigationControls = ({
  address,
  canDrive,
  homePending,
  onAddressBlur,
  onAddressChange,
  onAddressFocus,
  onBack,
  onForward,
  onHome,
  onNavigate,
  onReload,
  onSwitchTab,
  onViewport,
  presetId,
  tabs,
  viewport,
  viewportDisabled,
}: BrowserNavigationControlsProps) => (
  <>
    <button className="admin-button admin-button-secondary admin-button-compact" disabled={!canDrive} onClick={onBack} type="button">Back</button>
    <button className="admin-button admin-button-secondary admin-button-compact" disabled={!canDrive} onClick={onForward} type="button">Forward</button>
    <button className="admin-button admin-button-secondary admin-button-compact" disabled={!canDrive} onClick={onReload} type="button">Reload</button>
    {tabs.length > 1 ? <label className="sr-only" htmlFor="browser-tab">Browser tab</label> : null}
    {tabs.length > 1 ? (
      <select
        className="admin-input admin-input-sm max-w-40"
        disabled={!canDrive}
        id="browser-tab"
        onChange={(event) => onSwitchTab(event.target.value)}
        value={tabs.find((tab) => tab.url === address)?.id ?? ''}
      >
        {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.url || 'New tab'}</option>)}
      </select>
    ) : null}
    <form className="min-w-[12rem] flex-1" onSubmit={(event) => { event.preventDefault(); onNavigate() }}>
      <label className="sr-only" htmlFor="browser-address">Address</label>
      <input className="admin-input admin-input-sm w-full" disabled={!canDrive} id="browser-address" inputMode="url" onBlur={onAddressBlur} onChange={(event) => onAddressChange(event.target.value)} onFocus={onAddressFocus} placeholder="https://" type="url" value={address} />
    </form>
    <label className="sr-only" htmlFor="browser-viewport">Window size</label>
    <select className="admin-input admin-input-sm w-auto" disabled={viewportDisabled} id="browser-viewport" onChange={(event) => {
      const preset = BROWSER_VIEWPORT_PRESETS.find((option) => option.id === event.target.value)
      if (preset) onViewport(preset.viewport)
    }} value={presetId ?? ''}>
      {presetId === null && viewport ? <option value="">{viewport.width}×{viewport.height}</option> : null}
      {BROWSER_VIEWPORT_PRESETS.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label} · {option.viewport.width}×{option.viewport.height}
        </option>
      ))}
    </select>
    <button className="admin-button admin-button-secondary admin-button-compact" disabled={!canDrive || homePending} onClick={onHome} type="button">
      {homePending ? 'Going…' : 'Home'}
    </button>
  </>
)
