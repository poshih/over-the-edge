import type { AvatarJointId } from '../character-profile';

// Workshop labels for the joints an avatar bone map drives. Left and right are screen sides.
export const AVATAR_JOINT_LABELS: Readonly<Record<AvatarJointId, string>> = {
  body: 'Body', head: 'Head',
  'left-upper-arm': 'Left upper arm', 'left-forearm': 'Left forearm', 'left-hand': 'Left hand',
  'right-upper-arm': 'Right upper arm', 'right-forearm': 'Right forearm', 'right-hand': 'Right hand',
};
