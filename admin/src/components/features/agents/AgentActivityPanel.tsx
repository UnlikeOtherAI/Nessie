import { useCallback, useState } from 'react';
import type { AgentRecord } from '../../../lib/api-client';
import { agentGradient, getInitials } from '../../../lib/avatar';
import { getCookie, setCookie } from '../../../lib/storage';
import { useBindAgent } from '../../../facades/agents/hooks';
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
  collapsible?: boolean;
  currentChannelId?: string | null;
  onCreateAgent?: () => void;
  onSelectAgent: (agentId: string) => void;
  realtime: AgentRealtimeState;
  selectedAgentId?: string | null;
  title?: string;
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
  'var(--accent-soft)',
  'var(--info-soft)',
  'var(--success-soft)',
  'var(--warning-soft)',
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
  collapsible = true,
  currentChannelId,
  onCreateAgent,
  onSelectAgent,
  realtime,
  selectedAgentId,
  title = 'Agents',
}: AgentActivityPanelProps) => {
  const [collapsed, setCollapsed] = useState(() => getCookie('agentsCollapsed') === '1');
  const bindAgent = useBindAgent();
  const isCollapsed = collapsible ? collapsed : false;

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCookie('agentsCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const handleCreateAgent = useCallback(() => {
    if (onCreateAgent) {
      onCreateAgent();
      return;
    }
    window.location.assign('/agents/designer');
  }, [onCreateAgent]);

  const sortedAgents = [...agents].sort((left, right) => {
    // Channel-bound agents first when viewing a channel
    if (currentChannelId) {
      const leftBound = left.channelIds.includes(currentChannelId) ? 1 : 0;
      const rightBound = right.channelIds.includes(currentChannelId) ? 1 : 0;
      if (leftBound !== rightBound) return rightBound - leftBound;
    }

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

  const handleAddToChannel = (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    if (!currentChannelId) return;
    bindAgent.mutate({ agentId, channelId: currentChannelId });
  };

  return (
    <section id="activity">
      {collapsible ? (
        <div className="admin-sec-row mt-2">
          <button
            aria-controls="sidebar-nav-agents"
            aria-expanded={!isCollapsed}
            className="admin-sec-hdr"
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
            <span>{title}</span>
          </button>
          <button
            aria-label="Create agent"
            className="admin-sidebar-plus"
            onClick={handleCreateAgent}
            type="button"
          >
            +
          </button>
        </div>
      ) : (
        <div className="admin-sec-hdr mt-2">
          <span>{title}</span>
          <span
            className={[
              'ml-auto rounded bg-[var(--overlay-weak)] px-1.5 py-0.5 text-[10px]',
              'font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
          >
            {connectionLabel[realtime.connectionState]}
          </span>
        </div>
      )}

      {!isCollapsed && (
        <div id="sidebar-nav-agents">
          {sortedAgents.length === 0 ? (
            <div
              className={[
                'mx-2 rounded-md border border-dashed border-[color:var(--sep)]',
                'bg-[var(--overlay-weak)] px-3 py-3 text-sm text-[color:var(--tx3)]',
              ].join(' ')}
            >
              No agents created yet.
            </div>
          ) : (
            sortedAgents.map((agent, index) => {
              const record = realtime.records[agent.id];
              const status = record?.status ?? agent.status;
              const isBound = currentChannelId
                ? agent.channelIds.includes(currentChannelId)
                : false;
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

              if (collapsible) {
                return (
                  <button
                    key={agent.id}
                    className={[
                      'admin-sb-item group',
                      selectedAgentId === agent.id ? 'active' : '',
                    ].join(' ')}
                    onClick={() => onSelectAgent(agent.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
                        'text-[9px] font-bold text-[var(--on-accent)]',
                        currentChannelId && !isBound ? 'opacity-50' : '',
                      ].join(' ')}
                      style={{ background: agentGradient }}
                    >
                      {getInitials(agent.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    {currentChannelId && !isBound ? (
                      <span
                        className={[
                          'ml-auto hidden shrink-0 rounded p-0.5 text-[color:var(--tx3)]',
                          'hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
                          'group-hover:inline-flex',
                        ].join(' ')}
                        onClick={(e) => handleAddToChannel(e, agent.id)}
                        role="button"
                        title="Add to this channel"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          viewBox="0 0 24 24"
                        >
                          <path
                            d="M12 5v14M5 12h14"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                );
              }

              return (
                <button
                  key={agent.id}
                  className={[
                    'group mx-2 flex w-[calc(100%-1rem)] items-start gap-2 rounded-md px-2 py-2',
                    'text-left transition hover:bg-[var(--overlay-weak)]',
                    selectedAgentId === agent.id
                      ? 'bg-[color:var(--sb-active)] text-[var(--on-accent)]'
                      : currentChannelId && !isBound
                        ? 'text-[color:var(--tx3)]'
                        : 'text-[color:var(--tx2)]',
                  ].join(' ')}
                  onClick={() => onSelectAgent(agent.id)}
                  type="button"
                >
                  <div
                    className={[
                      'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px]',
                      currentChannelId && !isBound ? 'opacity-50' : '',
                    ].join(' ')}
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
                            'text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--thinking)]',
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
                  <div className="mt-1 flex items-center gap-1">
                    {currentChannelId && !isBound ? (
                      <span
                        className={[
                          'hidden rounded p-0.5 text-[color:var(--tx3)]',
                          'hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
                          'group-hover:inline-flex',
                        ].join(' ')}
                        onClick={(e) => handleAddToChannel(e, agent.id)}
                        role="button"
                        title="Add to this channel"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          viewBox="0 0 24 24"
                        >
                          <path
                            d="M12 5v14M5 12h14"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    ) : null}
                    <AgentStatusDot status={status} />
                  </div>
                </button>
              );
            })
          )}

          {!collapsible ? (
            <button
              className="admin-sb-item text-[color:var(--tx3)]"
              onClick={handleCreateAgent}
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
          ) : null}
        </div>
      )}
    </section>
  );
};
