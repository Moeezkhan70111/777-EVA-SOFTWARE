// Artwork for the Home dashboard cards — one place to change it (R3). The files live in
// src/renderer/assets and are copied to dist by scripts/build-renderer.mjs, so they work offline.

/** The injection moulding machine drawn on the Machine Program card. */
export const MACHINE_ARTWORK_URL = "./assets/machines/machine.png";

/**
 * The gatepass, truck and warehouse scene on the Create Gatepass card. It carries its own green
 * cloud and sparks (cut from the owner's card design), so the card does not draw them again.
 */
export const CREATE_GATEPASS_ARTWORK_URL = "./assets/gatepass/create-gatepass.png";

/**
 * The Gatepass List card: the list panel in front of the warehouse, truck and barrier. Drawn as
 * a vector (SVG), so it stays sharp at any size; the card draws its green cloud and sparks.
 */
export const GATEPASS_LIST_ARTWORK_URL = "./assets/gatepass/gatepass-list.svg";
