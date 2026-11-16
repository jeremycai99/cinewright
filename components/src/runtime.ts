import { bulletReveal } from "./bullet_reveal/index.js";
import { captionTrack } from "./caption_track/index.js";
import { chart } from "./chart/index.js";
import { endCard } from "./end_card/index.js";
import { mount, register } from "./host/mount.js";
import { kineticTitle } from "./kinetic_title/index.js";
import { lowerThird } from "./lower_third/index.js";
import { plate } from "./plate/index.js";
import { quoteCard } from "./quote_card/index.js";

/** The browser bundle (components/src/node/bundle.ts): every core component plus the host. */
register("kinetic_title", kineticTitle);
register("bullet_reveal", bulletReveal);
register("end_card", endCard);
register("caption_track", captionTrack);
register("lower_third", lowerThird);
register("chart", chart);
register("quote_card", quoteCard);
register("plate", plate);

declare global {
  interface Window {
    cinewright: { mount: typeof mount };
  }
}

window.cinewright = { mount };
