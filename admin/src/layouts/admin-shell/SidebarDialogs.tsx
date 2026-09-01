import { CreateChannelDialog } from '../../components/shared/CreateChannelDialog';
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog';
import { EditProjectDialog } from '../../components/shared/EditProjectDialog';
import type { CreateChannelTarget, EditProjectTarget } from './types';

type SidebarDialogsProps = {
  createChannelTarget: CreateChannelTarget | null;
  createProjectOpen: boolean;
  onCloseCreateChannel: () => void;
  onCloseCreateProject: () => void;
  editProjectTarget: EditProjectTarget | null;
  onCloseEditProject: () => void;
};

export const SidebarDialogs = ({
  createChannelTarget,
  createProjectOpen,
  onCloseCreateChannel,
  onCloseCreateProject,
  editProjectTarget,
  onCloseEditProject,
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
      {editProjectTarget ? (
        <EditProjectDialog
          onClose={onCloseEditProject}
          open
          project={editProjectTarget}
        />
      ) : null}
    </>
  );
};
