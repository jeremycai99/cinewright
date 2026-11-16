import { mount, register } from "./host/mount.js";
import { kineticTitle } from "./kinetic_title/index.js";

/** The browser bundle (components/src/node/bundle.ts): every core component plus the host. */
register("kinetic_title", kineticTitle);

declare global {
  interface Window {
    cinewright: { mount: typeof mount };
  }
}

window.cinewright = { mount };
