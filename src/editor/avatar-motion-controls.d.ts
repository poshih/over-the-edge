// The motion kinds' Workshop controls, from AVATAR_RIG_MODULE's editor-only `controls` export, validated against the
// registry; none without a module.
declare module 'virtual:avatar-motion-controls' {
  const controls: import('../avatar-motion').AvatarMotionControls;
  export default controls;
}
