import { defineRelease, MENU, replace } from '../../src/plugins/release-sdk';
import { createMainMenu } from './menu';

// The release holds play behind this menu until the player starts a new game or continues the saved one.
export default defineRelease({
  start() {
    return [replace(MENU, createMainMenu)];
  },
});
