import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  channelHashClassName,
  projectSelectionClassName,
  renderUnreadCount,
  sidebarAriaCurrent,
} from './SidebarRow';
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar';
import { getCookie, setCookie } from '../../lib/storage';
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { GroupDmSidebarLabel } from './GroupDmSidebarLabel';
import { SidebarEmptyNote } from './SidebarEmptyNote';
import { SidebarMenuSection } from './SidebarMenuSection';
import { useSidebarRowMenu } from './useSidebarRowMenu';
import type {
  CreateChannelTarget,
  EditProjectTarget,
  RevealedChannel,
  SidebarMenu,
  SidebarProject,
} from './types';

const COLLAPSED_PROJECT_IDS_COOKIE = 'collapsedProjectIds';

export const parseCollapsedProjectIds = (value: string | null): Set<string> => {
  if (!value) return new Set();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
};

export const retainCollapsedProjectIds = (
  collapsedProjectIds: ReadonlySet<string>,
  projects: readonly SidebarProject[],
): Set<string> => {
  const projectIds = new Set(projects.map((project) => project.id));
  return new Set([...collapsedProjectIds].filter((projectId) => projectIds.has(projectId)));
};

export const serializeCollapsedProjectIds = (collapsedProjectIds: ReadonlySet<string>): string =>
  JSON.stringify([...collapsedProjectIds]);

/**
 * The collapsed set with one project opened. Returns the set it was given when
 * that project is already open, so the caller can skip the state write and the
 * cookie: a new Set every render is a re-render every render.
 */
export const expandCollapsedProject = (
  collapsedProjectIds: ReadonlySet<string>,
  projectId: string,
): ReadonlySet<string> => {
  if (!collapsedProjectIds.has(projectId)) return collapsedProjectIds;
  const next = new Set(collapsedProjectIds);
  next.delete(projectId);
  return next;
};

type SidebarProjectsSectionProps = {
  attentionCountByProjectId: Map<string, number>;
  currentChannelId?: string;
  currentProjectId?: string;
  onNavigateChannel: (channelId: string) => void;
  onNavigateProject: (projectId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onOpenEditProject: (target: EditProjectTarget) => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  projectsCollapsed: boolean;
  revealedChannel: RevealedChannel | null;
  setSidebarMenu: (updater: (current: SidebarMenu) => SidebarMenu) => void;
  sidebarMenu: SidebarMenu;
  sidebarProjects: SidebarProject[];
  sidebarProjectsLoaded: boolean;
  starredChannelIds: Set<string>;
  starredProjectIds: Set<string>;
  teamIdByProjectId: Map<string, string>;
  toggleProjectsCollapsed: () => void;
  visibleSidebarProjects: SidebarProject[];
};

export const SidebarProjectsSection = ({
  attentionCountByProjectId,
  currentChannelId,
  currentProjectId,
  onNavigateChannel,
  onNavigateProject,
  onOpenCreateChannel,
  onOpenCreateProject,
  onOpenEditProject,
  onToggleStar,
  projectsCollapsed,
  revealedChannel,
  setSidebarMenu,
  sidebarMenu,
  sidebarProjects,
  sidebarProjectsLoaded,
  starredChannelIds,
  starredProjectIds,
  teamIdByProjectId,
  toggleProjectsCollapsed,
  visibleSidebarProjects,
}: SidebarProjectsSectionProps) => {
  const { token } = useAuthSession();
  const prewarm = usePrewarm();
  const [collapsedProjectIds, setCollapsedProjectIds] = useState(() =>
    parseCollapsedProjectIds(getCookie(COLLAPSED_PROJECT_IDS_COOKIE)),
  );

  const persistCollapsedProjectIds = useCallback((projectIds: ReadonlySet<string>) => {
    setCookie(COLLAPSED_PROJECT_IDS_COOKIE, serializeCollapsedProjectIds(projectIds));
  }, []);

  useEffect(() => {
    if (!sidebarProjectsLoaded) return;

    setCollapsedProjectIds((current) => {
      const next = retainCollapsedProjectIds(current, sidebarProjects);
      if (next.size === current.size) return current;
      persistCollapsedProjectIds(next);
      return next;
    });
  }, [persistCollapsedProjectIds, sidebarProjects, sidebarProjectsLoaded]);

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      persistCollapsedProjectIds(next);
      return next;
    });
  }, [persistCollapsedProjectIds]);

  // A channel nobody can see is not a channel that was created: a channel added
  // to a project whose list is closed opens that list. Keyed by the new
  // channel's id, so collapsing the project and adding another one opens it
  // again — and so this never fights a collapse the person performs afterwards.
  useEffect(() => {
    const projectId = revealedChannel?.projectId;
    if (!projectId) return;

    setCollapsedProjectIds((current) => {
      const next = expandCollapsedProject(current, projectId);
      if (next === current) return current;
      persistCollapsedProjectIds(next);
      return next as Set<string>;
    });
  }, [persistCollapsedProjectIds, revealedChannel]);

  const closeProjectMenu = useCallback(() => {
    setSidebarMenu(() => null);
  }, [setSidebarMenu]);

  // Only one project menu is ever open at a time — `sidebarMenu` (lifted so it
  // can coordinate with the channel menu's own open/closed state) says which,
  // and the shared hook owns the position plus the Escape/scroll/resize close.
  const { openAt, position: menuPosition } = useSidebarRowMenu(
    sidebarMenu?.type === 'project',
    closeProjectMenu,
  );

  return (
    <SidebarMenuSection
      action={
        <button
          aria-label="Create project"
          className="admin-sidebar-plus"
          onClick={onOpenCreateProject}
          type="button"
        >
          +
        </button>
      }
      id="sidebar-nav-projects"
      isCollapsed={projectsCollapsed}
      onToggle={toggleProjectsCollapsed}
      title="Projects"
    >
      {visibleSidebarProjects.length === 0 ? (
        <SidebarEmptyNote>There are no projects in this team yet.</SidebarEmptyNote>
      ) : visibleSidebarProjects.map((project) => {
        const isStarredProject = starredProjectIds.has(project.id);
        const isProjectCollapsed = collapsedProjectIds.has(project.id);
        const isProjectMenuOpen =
          sidebarMenu?.type === 'project' && sidebarMenu.projectId === project.id;
        const projectChannelsId = `sidebar-project-${project.id}-channels`;
        const projectUnreadCount = project.channels.reduce(
          (total, channel) => total + channel.unreadCount,
          0,
        ) + (attentionCountByProjectId.get(project.id) ?? 0);

        return (
          <div key={project.id} className="mt-1">
            <div
              className={[
                'admin-sb-item sidebar-project-tile group',
                isProjectCollapsed && projectUnreadCount > 0 ? 'unread' : '',
                projectSelectionClassName(project.id, currentProjectId, currentChannelId),
              ].join(' ')}
            >
              <button
                aria-current={sidebarAriaCurrent(
                  projectSelectionClassName(project.id, currentProjectId, currentChannelId) === 'active',
                )}
                className="sidebar-project-link"
                onClick={() => onNavigateProject(project.id)}
                type="button"
                {...prewarmRowHandlers(prewarm, `/projects/${project.id}`)}
              >
                <ProjectAvatar
                  avatarAttachmentId={project.avatarAttachmentId}
                  avatarEmoji={project.avatarEmoji}
                  size={18}
                  token={token}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {isProjectCollapsed ? renderUnreadCount(projectUnreadCount) : null}
              </button>
              <button
                aria-controls={projectChannelsId}
                aria-expanded={!isProjectCollapsed}
                aria-label={`${isProjectCollapsed ? 'Expand' : 'Collapse'} ${project.name} channels`}
                className="admin-sidebar-more flex-shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleProjectCollapsed(project.id);
                }}
                type="button"
              >
                <svg
                  className={[
                    'h-3 w-3 transition-transform',
                    isProjectCollapsed ? '-rotate-90' : '',
                  ].join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                >
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span
                className={[
                  'sidebar-row-star flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                  isStarredProject
                    ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
                    : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
                ].join(' ')}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStar('project', project.id);
                }}
              >
                {isStarredProject ? '★' : '☆'}
              </span>
              <span className="relative ml-1 flex-shrink-0">
                <span
                  aria-label={`Project actions for ${project.name}`}
                  aria-expanded={isProjectMenuOpen}
                  aria-haspopup="menu"
                  className="admin-sidebar-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isProjectMenuOpen) {
                      closeProjectMenu();
                      return;
                    }

                    openAt(e.currentTarget.getBoundingClientRect());
                    setSidebarMenu(() => ({ projectId: project.id, type: 'project' }));
                  }}
                  role="button"
                  tabIndex={0}
                >
                  ⋯
                </span>
                {isProjectMenuOpen && menuPosition
                  ? createPortal(
                      <>
                        <button
                          aria-hidden="true"
                          className="fixed inset-0 z-[var(--layer-popover)] cursor-default"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeProjectMenu();
                          }}
                          tabIndex={-1}
                          type="button"
                        />
                        <span
                          className="admin-sidebar-menu admin-sidebar-menu-project fixed z-[var(--layer-popover)]"
                          onClick={(e) => e.stopPropagation()}
                          role="menu"
                          style={menuPosition}
                        >
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              closeProjectMenu();
                              onOpenCreateChannel({
                                projectName: project.name,
                                teamId: teamIdByProjectId.get(project.id),
                              });
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            Add new channel within project
                          </span>
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              closeProjectMenu();
                              onOpenEditProject(project);
                            }}
                            role="button"
                            tabIndex={0}
                          >
                            Edit
                          </span>
                        </span>
                      </>,
                      document.body,
                    )
                  : null}
              </span>
            </div>

            {!isProjectCollapsed ? (
              <div id={projectChannelsId}>
                {project.channels.length === 0 ? (
                  <SidebarEmptyNote nested>There are no channels yet.</SidebarEmptyNote>
                ) : null}
                {project.channels.map((channel) => {
                  const isStarredChannel = starredChannelIds.has(channel.id);
                  return (
                    <button
                      aria-current={sidebarAriaCurrent(channel.id === currentChannelId)}
                      key={channel.id}
                      className={[
                        'admin-sb-item sidebar-child group',
                        channel.unreadCount > 0 ? 'unread' : '',
                        channel.id === currentChannelId ? 'active' : '',
                      ].join(' ')}
                      onClick={() => onNavigateChannel(channel.id)}
                      type="button"
                      {...prewarmRowHandlers(prewarm, `/channels/${channel.id}`)}
                    >
                      <span className={channelHashClassName}>#</span>
                      <GroupDmSidebarLabel label={channel.label} />
                      {renderUnreadCount(channel.unreadCount)}
                      <span
                        className={[
                          'sidebar-row-star flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                          isStarredChannel
                            ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
                            : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
                        ].join(' ')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleStar('channel', channel.id);
                        }}
                      >
                        {isStarredChannel ? '★' : '☆'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </SidebarMenuSection>
  );
};
