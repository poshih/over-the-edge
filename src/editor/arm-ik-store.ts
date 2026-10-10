import { AppearanceError, DEFAULT_ARM_IK } from './appearance-types';
import type { DocumentArmIk } from './document/project-document';
import { armIkValue } from './document/visual-values';
import { expectSnapshotFields, NamedSnapshots, readSnapshotJson, SnapshotError } from './named-snapshots';
import type { NamedSnapshot } from './named-snapshots';

const ACTIVE_KEY = 'over-the-edge:appearance:arm-ik:active:v2';
const VERSION = 2;

export interface ArmIkProfile extends NamedSnapshot<DocumentArmIk> {
  readonly key: string;
}

export const armIkProfiles = new NamedSnapshots({
  prefix: 'over-the-edge:appearance:arm-ik:profile:v2:', version: VERSION, field: 'settings', label: 'IK profile',
  namePrompt: 'Enter an IK profile name', validate: (value) => armIkValue(value, DEFAULT_ARM_IK),
  isDataError: (error) => error instanceof AppearanceError,
});

export function readArmIkProfile(storage: Storage, key: string): ArmIkProfile {
  return Object.freeze({ key, ...armIkProfiles.read(storage, key) });
}

export function readActiveArmIk(storage: Storage): ArmIkProfile | null {
  if (storage.getItem(ACTIVE_KEY) === null) return null;
  const record = readSnapshotJson(storage, ACTIVE_KEY, 'IK selection');
  expectSnapshotFields(record, ['schemaVersion', 'key'], 'IK selection');
  if (record.schemaVersion !== VERSION || typeof record.key !== 'string') {
    throw new SnapshotError('Saved IK selection is invalid: unsupported version or profile key.');
  }
  return readArmIkProfile(storage, record.key);
}

export function selectArmIkProfile(storage: Storage, key: string): void {
  armIkProfiles.read(storage, key);
  storage.setItem(ACTIVE_KEY, JSON.stringify({ schemaVersion: VERSION, key }));
}
