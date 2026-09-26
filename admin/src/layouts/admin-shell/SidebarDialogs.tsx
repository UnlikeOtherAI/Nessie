import { CreateChannelDialog } from '../../components/shared/CreateChannelDialog';
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog';
import type { ChannelRecord } from '../../lib/api-client';
import type { CreateChannelTarget } from './types';

type SidebarDialogsProps = {
  createChannelTarget: CreateChannelTarget | null;
  createProjectOpen: boolean;
  onCloseCreateChannel: () => void;
  onCloseCreateProject: () => void;
  onCreatedChannel: (channel: ChannelRecord) => void;
};

export const SidebarDialogs = ({
  createChannelTarget,
  createProjectOpen,
  onCloseCreateChannel,
  onCloseCreateProject,
  onCreatedChannel,
}: SidebarDialogsProps) => {
  return (
    <>
      <CreateChannelDialog
        onClose={onCloseCreateChannel}
        onCreated={onCreatedChannel}
        open={createChannelTarget !== null}
        projectName={createChannelTarget?.projectName}
        projectId={createChannelTarget?.projectId}
        scope={createChannelTarget?.scope}
        teamId={createChannelTarget?.teamId}
      />
      <CreateProjectDialog onClose={onCloseCreateProject} open={createProjectOpen} />
    </>
  );
};
