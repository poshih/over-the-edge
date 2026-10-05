// Public kinds SDK. Pure trusted code selected by content IDs; see docs/kinds-plugins.md.
export {
  add, isNamespacedId, namespaceOf, PLUGIN_API_VERSION, PLUGIN_ERROR_CODES, PLUGIN_LIMITS, PluginError, pluginRefusal, replace, wrap,
} from './kernel';
export type { Contribution, KeyedPoint, ListPoint, PluginEnvironment, SlotPoint } from './kernel';
export { defineKinds } from './kinds';
export type { KindsFacet } from './kinds';
export {
  AVATAR_MOTIONS, AVATAR_RIGS, AvatarRigError, STANDARD_AVATAR_DRIVER, STANDARD_AVATAR_FRAME_PLANNER,
  bindArmNormal, composeArmJoints, composeLimbJoints, createArmSolutions, createFramePlan, createPose,
  fitAvatarRig, handFrame, limbFrame, projectGripShoulder, SHOULDER_CENTER, SHOULDER_SPAN,
  AVATAR_MOTION_ERROR_CODES, AVATAR_MOTION_ERROR_KIND, AVATAR_MOTION_LIMITS, AVATAR_MOTION_MAX_STEPS,
  AVATAR_MOTION_STEP_SECONDS, AvatarMotionError, HAIR_MOTION_ID,
} from '../avatar-rig';
export type {
  AvatarDriver, AvatarFramePlanner, AvatarRig, AvatarRigStrategy, RigJson,
  AvatarRigArmBind, AvatarRigArmPose, AvatarRigArmSolution, AvatarRigBinds, AvatarRigFrameContext,
  AvatarRigFramePlan, AvatarRigHandTrack, AvatarRigPose, AvatarRigPoseContext,
  AvatarMotion, AvatarMotionEntry, AvatarMotionFrame, AvatarMotionJoint, AvatarMotionKind, AvatarMotionModel, AvatarMotionSkeleton,
} from '../avatar-rig';
export type { AvatarJointId } from '../character-profile';
