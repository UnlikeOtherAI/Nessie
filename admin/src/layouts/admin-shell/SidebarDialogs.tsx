import { CreateChannelDialog } from '../../components/shared/CreateChannelDialog';
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog';
import { RenameProjectDialog } from '../../components/shared/RenameProjectDialog';
import type { CreateChannelTarget, RenameProjectTarget } from './types';

type SidebarDialogsProps = {
  createChannelTarget: CreateChannelTarget | null;
  createProjectOpen: boolean;
  onCloseCreateChannel: () => void;
  onCloseCreateProject: () => void;
  onCloseRenameProject: () => void;
  renameProjectTarget: RenameProjectTarget | null;
};

export const SidebarDialogs = ({
  createChannelTarget,
  createProjectOpen,
  onCloseCreateChannel,
  onCloseCreateProject,
  onCloseRenameProject,
  renameProjectTarget,
}: SidebarDialogsProps) => {
  return (
    <>
      <CreateChannelDialog
        onClose={onCloseCreateChannel}
        open={createChannelTarget !== null}
        projectName={createChannelTarget?.projectName}
        scope={createChannelTarget?.scope}
        teamId={createChannelTarget?.teamId}
      />
      <CreateProjectDialog onClose={onCloseCreateProject} open={createProjectOpen} />
      {renameProjectTarget ? (
        <RenameProjectDialog
          currentName={renameProjectTarget.name}
          onClose={onCloseRenameProject}
          open
          projectId={renameProjectTarget.id}
        />
      ) : null}
    </>
  );
};
