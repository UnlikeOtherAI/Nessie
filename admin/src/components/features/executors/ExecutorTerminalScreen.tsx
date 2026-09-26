import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ExecutorSessionScreen } from '@nessie/schemas'
import '@xterm/xterm/css/xterm.css'

/** One viewer for session links and the machine's session list. No input path. */
const TerminalView = ({ screen }: { screen: ExecutorSessionScreen }) => {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (!element.current) return
    const instance = new Terminal({
      cols: 120, rows: 36, disableStdin: true, cursorBlink: false, scrollback: 500,
      fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      allowProposedApi: false, screenReaderMode: true,
    })
    instance.open(element.current)
    terminal.current = instance
    return () => { terminal.current = null; last.current = null; instance.dispose() }
  }, [])
  useEffect(() => {
    const instance = terminal.current
    const host = element.current
    if (!instance || !host) return
    const styles = getComputedStyle(host)
    instance.options.theme = {
      background: styles.getPropertyValue('--terminal-bg').trim(),
      foreground: styles.getPropertyValue('--terminal-fg').trim(),
      cursor: styles.getPropertyValue('--terminal-fg').trim(),
    }
    const identity = `${screen.cols}:${screen.rows}:${screen.ansi}`
    if (last.current === identity) return
    last.current = identity
    const oldPosition = instance.buffer.active.viewportY
    const following = oldPosition >= instance.buffer.active.baseY
    instance.resize(screen.cols, screen.rows)
    instance.reset()
    instance.write(screen.ansi, () => {
      if (following) instance.scrollToBottom()
      else instance.scrollToLine(oldPosition)
    })
  }, [screen])
  return (
    <div className="executor-terminal-screen min-h-0 overflow-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--terminal-bg)] p-3"
      data-testid="executor-terminal-screen" aria-label="Read-only session terminal" role="region">
      <div className="w-max" ref={element} />
    </div>
  )
}


export const ExecutorTerminalScreen = ({ screen, plainText = false }: {
  screen: ExecutorSessionScreen
  plainText?: boolean
}) => plainText ? (
  <pre className="whitespace-pre-wrap break-words rounded-lg border border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx)]"
    data-testid="executor-terminal-screen" aria-label="Native session overview" role="region">
    {screen.ansi.trim()}
  </pre>
) : <TerminalView screen={screen} />
