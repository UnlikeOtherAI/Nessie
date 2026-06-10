import { channelHashClassName, renderUnreadCount } from './SidebarRow';
import type {
  CreateChannelTarget,
  RenameProjectTarget,
  SidebarMenu,
  SidebarProject,
} from './types';

type SidebarProjectsSectionProps = {
  currentChannelId?: string;
  currentProjectId?: string;
  onNavigateChannel: (channelId: string) => void;
  onNavigateProject: (projectId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onOpenRenameProject: (target: RenameProjectTarget) => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  projectsCollapsed: boolean;
  setSidebarMenu: (updater: (current: SidebarMenu) => SidebarMenu) => void;
  sidebarMenu: SidebarMenu;
  starredChannelIds: Set<string>;
  starredProjectIds: Set<string>;
  teamIdByProjectId: Map<string, string>;
  toggleProjectsCollapsed: () => void;
  visibleSidebarProjects: SidebarProject[];
};

export const SidebarProjectsSection = ({
  currentChannelId,
  currentProjectId,
  onNavigateChannel,
  onNavigateProject,
  onOpenCreateChannel,
  onOpenCreateProject,
  onOpenRenameProject,
  onToggleStar,
  projectsCollapsed,
  setSidebarMenu,
  sidebarMenu,
  starredChannelIds,
  starredProjectIds,
  teamIdByProjectId,
  toggleProjectsCollapsed,
  visibleSidebarProjects,
}: SidebarProjectsSectionProps) => {
  if (visibleSidebarProjects.length === 0) {
    return null;
  }

  return (
    <>
      <div className="admin-sec-row">
        <button
          className="admin-sec-hdr"
          onClick={toggleProjectsCollapsed}
          type="button"
        >
          <svg
            className={[
              'h-3 w-3 text-[color:var(--tx3)] transition-transform',
              projectsCollapsed ? '-rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Projects
        </button>
        <button
          aria-label="Create project"
          className="admin-sidebar-plus"
          onClick={onOpenCreateProject}
          type="button"
        >
          +
        </button>
      </div>

      {!projectsCollapsed &&
        visibleSidebarProjects.map((project) => {
          const isStarredProject = starredProjectIds.has(project.id);
          const projectUnreadCount = project.channels.reduce(
            (total, channel) => total + channel.unreadCount,
            0,
          );

          return (
            <div key={project.id} className="mt-1">
              <button
                className={[
                  'admin-sb-item group font-semibold',
                  project.id === currentProjectId ? 'active-parent' : '',
                ].join(' ')}
                onClick={() => onNavigateProject(project.id)}
                type="button"
              >
                <svg
                  className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {renderUnreadCount(projectUnreadCount)}
                <span
                  className={[
                    'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
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
                    className="admin-sidebar-more"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSidebarMenu((current) =>
                        current?.type === 'project' && current.projectId === project.id
                          ? null
                          : { projectId: project.id, type: 'project' },
                      );
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    ⋯
                  </span>
                  {sidebarMenu?.type === 'project' && sidebarMenu.projectId === project.id ? (
                    <span className="admin-sidebar-menu admin-sidebar-menu-project">
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
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
                          onOpenRenameProject({ id: project.id, name: project.name });
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        Rename project
                      </span>
                    </span>
                  ) : null}
                </span>
              </button>

              {project.channels.map((channel) => {
                const isStarredChannel = starredChannelIds.has(channel.id);
                return (
                  <button
                    key={channel.id}
                    className={[
                      'admin-sb-item sidebar-child group',
                      channel.id === currentChannelId ? 'active' : '',
                    ].join(' ')}
                    onClick={() => onNavigateChannel(channel.id)}
                    type="button"
                  >
                    <span className={channelHashClassName}>#</span>
                    <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                    {renderUnreadCount(channel.unreadCount)}
                    <span
                      className={[
                        'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
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
          );
        })}
    </>
  );
};
