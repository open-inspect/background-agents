import type { ServiceName } from "@open-inspect/shared/service-auth";
import type { PublicationSession } from "./callback-publication-scope";
import { slackPostGate } from "./slack-post-gate";
import { teamlessPublicationGate } from "./teamless-publication-gate";

export interface PublicationReadPolicy {
  channelCount: 0 | 1;
  gate(session: PublicationSession, teamId: string | null): string | null;
}

export const PUBLICATION_READ_POLICIES: Partial<Record<ServiceName, PublicationReadPolicy>> = {
  "slack-bot": {
    channelCount: 1,
    gate: (session, teamId) => slackPostGate(session, teamId === null ? null : { teamId }),
  },
  "discord-bot": {
    channelCount: 0,
    gate: teamlessPublicationGate,
  },
};
