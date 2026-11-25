/** The relay (isolated world) tells the gain script (main world) the Tab Volume with this window event; `detail` is a number. */
export const VOLUME_EVENT = "finetune:volume";

/** Service worker → relay in every frame of a tab: `{ type, volume }`. */
export const SET_VOLUME = "finetune.setVolume";
/** Relay → service worker when a frame starts; answered with the tab's volume (a number). */
export const GET_VOLUME = "finetune.getVolume";
