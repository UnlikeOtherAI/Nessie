import { CreateChannelDialog } from '../../components/shared/CreateChannelDialog';
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog';
import { EditProjectDialog } from '../../components/shared/EditProjectDialog';
import type { ChannelRecord } from '../../lib/api-client';
import type { CreateChannelTarget, EditProjectTarget } from './types';

type SidebarDialogsProps = {
  createChannelTarget: CreateChannelTarget | null;
  createProjectOpen: boolean;
  onCloseCreateChannel: () => void;
  onCloseCreateProject: () => void;
  onCreatedChannel: (channel: ChannelRecord) => void;
  editProjectTarget: EditProjectTarget | null;
  onCloseEditProject: () => void;
};

export const SidebarDialogs = ({
  createChannelTarget,
  createProjectOpen,
  onCloseCreateChannel,
  onCloseCreateProject,
  onCreatedChannel,
  editProjectTarget,
  onCloseEditProject,
}: SidebarDialogsProps) => {
  return (
    <>
      <CreateChannelDialog
        onClose={onCloseCreateChannel}
        onCreated={onCreatedChannel}
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
