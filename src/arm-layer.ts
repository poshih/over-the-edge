/**
 * The render layer of a 3D character's arms. The camera always looks at the character from the front, where arms
 * reaching for the hammer would otherwise clip into the body, jar and head, so the view draws the actors without
 * this layer, then only the objects on it, together with the hammer and sharing its depth, so the hands hold the
 * handle: the mesh-part and Appearance arms, and the arm surfaces of the built-in and imported avatars, with their
 * outlines.
 */
export const ARM_LAYER = 1;
