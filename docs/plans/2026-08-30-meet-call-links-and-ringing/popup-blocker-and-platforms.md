# Call links + ringing — popup blockers and platform split

This chapter continues the numbered design in [the overview](./overview.md).

## 7. Popup-blocker strategy (the load-bearing design)

Browsers allow `window.open` only inside a user-activation call stack; any
`await` between click and open forfeits it. Restated as rules:

1. **The Meet URI travels in the ring payload** (SSE event *and* push), so
   Accept never fetches before opening — the open is the first synchronous
   statement of the click handler; the accept POST follows.
2. **The caller never auto-opens.** The popup presents an anchor; the
   caller's join is its own click. Never "create link, then `window.open`
   when the response arrives".
3. **Notification accepts use `clients.openWindow` inside
   `notificationclick`** — spec-defined as gesture-bearing. Same ordering
   rule: open first, `waitUntil` the fetch after.
4. **Blocked anyway → anchor fallback**, never a retry: any
   `window.open === null` path swaps in a visible "Join call" anchor. An
   `<a target="_blank">` on a real click is never blocked.
5. **No cross-device auto-open** ("accepted on phone → also open on
   desktop"): there is no gesture there; other devices show a passive
   "accepted — join" affordance instead.

## 8. Platform split — browser vs native shells

One `openExternalUrl(url)` helper in the admin, switching on the existing
shell detection (`isDesktopApp()` / `isReactNativeWebView()` — never UA
sniffing):

- **Browser:** `window.open(..., 'noopener,noreferrer')` + §7.4 fallback.
- **Desktop (Tauri):** `@tauri-apps/plugin-opener` `openUrl(meetingUri)` —
  already a permitted capability and already used by
  `external-auth.ts:32`; opens the default system browser, no popup
  blocker. Meet deliberately does **not** run in the shell's webview (no
  media entitlements there, by design).
- **Mobile (Expo WebView):** a **new bridge message**
  `nessie:open-external {url}` posted to the shell, handled in `App.tsx`
  with `Linking.openURL` (system browser). This bridge does not exist today
  — the only current external-open path is hardwired to the auth callback —
  and it follows the existing typed-guard pattern for bridge messages (an
  `isOpenExternalMessage` guard beside `isNativeShellPresentationMessage`),
  with the **allowlist enforced on the native side** (the call-provider
  origins: `meet.google.com`, the configured Jitsi domain,
  `teams.microsoft.com`) so a compromised page context cannot use it as an
  arbitrary URL launcher; a non-allowlisted URL is dropped and logged.
  The allowlist check parses the URL and compares **exact `https:`
  origins** (default ports, no substring/`startsWith` matching) plus
  provider path shapes; the Jitsi entry comes from the shell's own
  configuration of the server-declared domain, never from page content —
  an allowlist the page can supply is no allowlist. Two more hardening
  facts: the WebView today runs `originWhitelist={['*']}` with no
  navigation gate, so the same release restricts **top-level navigation
  to the admin origin** with the call origins externalized via
  `onShouldStartLoadWithRequest` (allowlisting those origins out to the
  system browser, never blanket-externalizing — a blanket rule breaks
  embedded content the WebView legitimately loads). Fallback when the
  shell predates the handler: `window.open`, in-place navigation — ugly
  but functional. And for completeness: agent-authored markdown renders
  links as inert `target=_blank` anchors with `noopener`
  (`MessageMarkdown.tsx`), and **only schema-validated server events and
  API records ever drive the call UI** — message content can never forge
  a ring.
- Ring parity: `IncomingCallProvider` renders identically inside the
  shells; native push covers the closed-app case.

