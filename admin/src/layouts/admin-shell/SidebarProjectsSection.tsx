import {
  channelHashClassName,
  projectSelectionClassName,
  renderUnreadCount,
} from './SidebarRow';
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { GroupDmSidebarLabel } from './GroupDmSidebarLabel';
import { SidebarMenuSection } from './SidebarMenuSection';
import type {
  CreateChannelTarget,
  EditProjectTarget,
  SidebarMenu,
  SidebarProject,
} from './types';

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
  setSidebarMenu: (updater: (current: SidebarMenu) => SidebarMenu) => void;
  sidebarMenu: SidebarMenu;
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
  setSidebarMenu,
  sidebarMenu,
  starredChannelIds,
  starredProjectIds,
  teamIdByProjectId,
  toggleProjectsCollapsed,
  visibleSidebarProjects,
}: SidebarProjectsSectionProps) => {
  const { token } = useAuthSession();
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
        <button
          className={[
            'mx-2 flex w-[calc(100%-1rem)] rounded-md border border-dashed',
            'border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-3',
            'text-left text-sm text-[color:var(--tx3)] hover:bg-[var(--overlay)]',
          ].join(' ')}
          onClick={onOpenCreateProject}
          type="button"
        >
          Create your first project.
        </button>
      ) : visibleSidebarProjects.map((project) => {
        const isStarredProject = starredProjectIds.has(project.id);
        const projectUnreadCount = project.channels.reduce(
          (total, channel) => total + channel.unreadCount,
          0,
        ) + (attentionCountByProjectId.get(project.id) ?? 0);

        return (
          <div key={project.id} className="mt-1">
            <button
              className={[
                'admin-sb-item sidebar-project-tile group',
                projectUnreadCount > 0 ? 'unread' : '',
                projectSelectionClassName(project.id, currentProjectId, currentChannelId),
              ].join(' ')}
              onClick={() => onNavigateProject(project.id)}
              type="button"
            >
              <ProjectAvatar
                avatarAttachmentId={project.avatarAttachmentId}
                avatarEmoji={project.avatarEmoji}
                name={project.name}
                size={18}
                token={token}
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {renderUnreadCount(projectUnreadCount)}
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
                  <>
                    <span
                      className="fixed inset-0 z-10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSidebarMenu(() => null);
                      }}
                      role="presentation"
                    />
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
                          onOpenEditProject(project);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        Edit
                      </span>
                    </span>
                  </>
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
                    channel.unreadCount > 0 ? 'unread' : '',
                    channel.id === currentChannelId ? 'active' : '',
                  ].join(' ')}
                  onClick={() => onNavigateChannel(channel.id)}
                  type="button"
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
        );
      })}
    </SidebarMenuSection>
  );
};
