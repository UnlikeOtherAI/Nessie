// Browser cloud cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const browserCloudKeys = {
  connections: ['browser-cloud', 'connections'] as const,
  /** The family root, for the rare change that touches whichever session is on screen. */
  sessions: ['browser-cloud', 'sessions'] as const,
  session: (sessionId?: string) => ['browser-cloud', 'sessions', sessionId] as const,
  screenshot: (sessionId?: string) => ['browser-cloud', 'sessions', sessionId, 'screenshot'] as const,
  threadSessions: (threadId?: string) =>
    ['browser-cloud', 'threads', threadId, 'sessions'] as const,
  threadSessionsRoot: ['browser-cloud', 'threads'] as const,
  agentBrowser: (agentId?: string) => ['browser-cloud', 'agents', agentId] as const,
  agentBrowserTabs: (threadId?: string, agentId?: string) =>
    ['browser-cloud', 'threads', threadId, 'agents', agentId, 'tabs'] as const,
  myLogins: ['browser-cloud', 'my-logins'] as const,
  cookieImport: (importId?: string) =>
    ['browser-cloud', 'cookie-import', importId ?? 'none'] as const,
}
