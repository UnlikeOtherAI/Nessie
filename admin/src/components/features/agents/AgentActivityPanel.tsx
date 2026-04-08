import { useCallback, useState } from 'react';
import type { AgentRecord } from '../../../lib/api-client';
import { getCookie, setCookie } from '../../../lib/storage';
import { AgentStatusDot } from './AgentStatusDot';

export type AgentRealtimeState = {
  connectionState: 'connected' | 'connecting' | 'disconnected';
  records: Record<
    string,
    {
      currentRunId?: string;
      currentToolName?: string;
      currentToolStartedAt?: string;
      since?: string;
      status: AgentRecord['status'];
    }
  >;
};

type AgentActivityPanelProps = {
  agents: AgentRecord[];
  onSelectAgent: (agentId: string) => void;
  realtime: AgentRealtimeState;
  selectedAgentId?: string | null;
};

const activeStatuses = new Set<AgentRecord['status']>([
  'executing',
  'thinking',
  'waiting_approval',
  'error',
]);

const connectionLabel: Record<AgentRealtimeState['connectionState'], string> = {
  connected: 'live',
  connecting: 'reconnecting',
  disconnected: 'offline',
};

const iconPalette = [
  'rgba(124,58,237,0.2)',
  'rgba(8,145,178,0.2)',
  'rgba(5,150,105,0.2)',
  'rgba(234,179,8,0.18)',
] as const;

const getAgentIcon = (agent: AgentRecord): string => {
  const role = agent.role.toLowerCase();
  if (role.includes('research')) {
    return '🔍';
  }
  if (role.includes('write')) {
    return '📝';
  }
  if (role.includes('coder') || role.includes('engineer') || role.includes('assistant')) {
    return '⚡';
  }
  return agent.name.slice(0, 1).toUpperCase();
};

export const AgentActivityPanel = ({
  agents,
  onSelectAgent,
  realtime,
  selectedAgentId,
}: AgentActivityPanelProps) => {
  const [collapsed, setCollapsed] = useState(() => getCookie('agentsCollapsed') === '1');

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCookie('agentsCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const sortedAgents = [...agents].sort((left, right) => {
    const leftRecord = realtime.records[left.id];
    const rightRecord = realtime.records[right.id];
    const leftStatus = leftRecord?.status ?? left.status;
    const rightStatus = rightRecord?.status ?? right.status;
    const leftActive = activeStatuses.has(leftStatus) ? 1 : 0;
    const rightActive = activeStatuses.has(rightStatus) ? 1 : 0;
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }

    const leftTs = Date.parse(
      leftRecord?.currentToolStartedAt ?? leftRecord?.since ?? left.lastActivityAt,
    );
    const rightTs = Date.parse(
      rightRecord?.currentToolStartedAt ?? rightRecord?.since ?? right.lastActivityAt,
    );
    return rightTs - leftTs;
  });

  return (
    <section id="activity">
      <button
        className="admin-sec-hdr mt-2"
        onClick={toggleCollapsed}
        type="button"
      >
        <svg
          className={[
            'h-3 w-3 text-[color:var(--tx3)] transition-transform',
            collapsed ? '-rotate-90' : '',
          ].join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Agents</span>
        <span
          className={[
            'ml-auto rounded bg-white/6 px-1.5 py-0.5 text-[10px]',
            'font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]',
          ].join(' ')}
        >
          {connectionLabel[realtime.connectionState]}
        </span>
      </button>

      {!collapsed && (
        <>
          {sortedAgents.length === 0 ? (
            <div
              className={[
                'mx-2 rounded-md border border-dashed border-[color:var(--sep)]',
                'bg-white/4 px-3 py-3 text-sm text-[color:var(--tx3)]',
              ].join(' ')}
            >
              No agents created yet.
            </div>
          ) : (
            sortedAgents.map((agent, index) => {
              const record = realtime.records[agent.id];
              const status = record?.status ?? agent.status;
              const currentTask =
                record?.currentToolName ??
                agent.currentToolName ??
                (status === 'thinking' ? 'Thinking through the current run.' : agent.role);
              const lastActivity = new Date(
                record?.currentToolStartedAt ?? record?.since ?? agent.lastActivityAt,
              ).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <button
                  key={agent.id}
                  className={[
                    'mx-2 flex w-[calc(100%-1rem)] items-start gap-2 rounded-md px-2 py-2',
                    'text-left transition hover:bg-white/8',
                    selectedAgentId === agent.id
                      ? 'bg-[color:var(--sb-active)] text-white'
                      : 'text-[color:var(--tx2)]',
                  ].join(' ')}
                  onClick={() => onSelectAgent(agent.id)}
                  type="button"
                >
                  <div
                    className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px]"
                    style={{ background: iconPalette[index % iconPalette.length] }}
                  >
                    {getAgentIcon(agent)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{agent.name}</span>
                      {status === 'executing' || status === 'thinking' ? (
                        <span
                          className={[
                            'rounded bg-[color:var(--accent-soft)] px-1.5 py-0.5',
                            'text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a78bfa]',
                          ].join(' ')}
                        >
                          {status}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-[color:var(--tx3)]">{currentTask}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {lastActivity}
                    </div>
                  </div>
                  <div className="mt-1">
                    <AgentStatusDot status={status} />
                  </div>
                </button>
              );
            })
          )}

          <button
            className="admin-sb-item text-[color:var(--tx3)]"
            onClick={() => window.location.assign('/agents/new')}
            type="button"
          >
            <svg
              className="h-4 w-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Create agent
          </button>
        </>
      )}
    </section>
  );
};
