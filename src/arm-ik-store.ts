import { AppearanceError, validateArmIk } from './appearance-types';
import { expectSnapshotFields, NamedSnapshots, readSnapshotJson, SnapshotError } from './named-snapshots';
import type { NamedSnapshot } from './named-snapshots';
import type { ArmIkSettings } from './appearance-types';

const ACTIVE_KEY = 'over-the-edge:appearance:arm-ik:active:v2';
const PREVIOUS_KEY = 'over-the-edge:appearance:arm-ik:v1';
const VERSION = 2;

export interface ArmIkProfile extends NamedSnapshot<ArmIkSettings> {
  key: string;
}

export const armIkProfiles = new NamedSnapshots({
  prefix: 'over-the-edge:appearance:arm-ik:profile:v2:', version: VERSION, field: 'settings', label: 'IK profile',
  namePrompt: 'Enter an IK profile name', validate: validateArmIk, isDataError: (error) => error instanceof AppearanceError,
});

export function readActiveArmIk(storage: Storage): { profile: ArmIkProfile | null; previousSave: boolean } {
  if (storage.getItem(ACTIVE_KEY) === null) {
    return { profile: null, previousSave: storage.getItem(PREVIOUS_KEY) !== null };
  }
  const record = readSnapshotJson(storage, ACTIVE_KEY, 'IK selection');
  expectSnapshotFields(record, ['schemaVersion', 'key'], 'IK selection');
  if (record.schemaVersion !== VERSION || typeof record.key !== 'string') {
    throw new SnapshotError('Saved IK selection is invalid: unsupported version or profile key.');
  }
  return { profile: { key: record.key, ...armIkProfiles.read(storage, record.key) }, previousSave: false };
}

export function activateArmIk(storage: Storage, key: string): ArmIkProfile {
  const profile = armIkProfiles.read(storage, key);
  storage.setItem(ACTIVE_KEY, JSON.stringify({ schemaVersion: VERSION, key }));
  return { ...profile, key };
}
