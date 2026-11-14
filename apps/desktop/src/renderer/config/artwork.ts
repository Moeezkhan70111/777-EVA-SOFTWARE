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

/**
 * The portrait on the Store page header's profile button (0.4.1): one picture for every user, cut from
 * the owner's header design (60px). Replace the file with the original artwork for a sharper one.
 */
export const STORE_AVATAR_URL = "./assets/store/avatar.png";

/**
 * The two Dashboard cards: the uppers, and the Dana bags with their pellets. Cut from the owner's
 * dashboard design with the card surface around them made transparent, so they sit on the live card.
 */
export const UPPER_STOCK_ARTWORK_URL = "./assets/stock/upper-stock.png";
export const DANA_STOCK_ARTWORK_URL = "./assets/stock/dana-stock.png";

/** The Carton Stock card: three 777 SEVEN cartons with slippers, from the owner's card design, cut the same way. */
export const CARTON_STOCK_ARTWORK_URL = "./assets/stock/carton-stock.png";

/**
 * The Daily Production card (14 Nov 2026): a production sheet with its day's bars, a machine and a finished 777
 * carton. Drawn as a vector (SVG) in the cards' sky palette, so it stays sharp; the card draws its cloud and sparks.
 */
export const DAILY_PRODUCTION_ARTWORK_URL = "./assets/production/daily-production.svg";
