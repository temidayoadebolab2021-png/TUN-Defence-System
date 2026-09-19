// ============================================================
// src/utils/attackGifs.js
// Themed GIFs for each P&W attack type.
//
// Most links below were hand-picked and provided directly by the
// server owner (hosted on imgbb) — these are intentional choices,
// not auto-sourced. A few categories (FORTIFY, PEACE, and the two
// AIRVSOLDIERS/AIRVTANKS airstrike variants) still use the earlier
// verified real-footage Giphy links since no replacement was given
// for those yet.
//
// Canonical type keys match the real P&W GraphQL `AttackType` enum:
// GROUND, AIRVINFRA, AIRVSOLDIERS, AIRVTANKS, AIRVMONEY, AIRVSHIPS,
// AIRVAIR, NAVALVSHIPS, NAVALVINFRA, NAVALVMONEY, MISSILE, MISSILEFAIL,
// NUKE, NUKEFAIL, FORTIFY, PEACE, VICTORY, ALLIANCELOOT.
// NOTE: naval attacks come back as NAVALVSHIPS / NAVALVINFRA (confirmed via
// live diagnostic logging on 2026-08-31), NOT a plain "NAVAL" — an older
// P&W schema reference gave "NAVAL" and that was wrong/outdated, which is
// why naval GIFs never worked across three different GIF sources before
// this was traced down. Kept NAVAL itself mapped too just in case.
// Old AIRSTRIKE_*/NAVAL_INFRA key names are kept as aliases below so
// nothing breaks if the API naming ever differs from what's confirmed.
//
// If you want to swap any GIF later: get an imgbb (or similar) DIRECT
// link ending in .gif (not the ibb.co page link — use the "direct
// link" option), and swap the relevant constant below.
// ============================================================

// ── User-provided (imgbb) ──────────────────────────────────────
const GROUND_GIF      = 'https://i.ibb.co/CKCDJcJj/In-Shot-20260831-084051141.gif';        // successful ground attacks
const DOGFIGHT_GIF    = 'https://i.ibb.co/608CJmns/In-Shot-20260831-083815100.gif';        // successful air-to-air dogfights (AIRVAIR)
const AIRSTRIKE_GIF   = 'https://i.ibb.co/CpvZm6YT/In-Shot-20260831-124023136.gif';        // successful airstrikes on ships/money/infrastructure
const NAVAL_GIF       = 'https://i.ibb.co/s978DhnM/rin5ef7mn7tf1.gif';                     // successful naval (ship-vs-ship) attacks
const MISSILE_GIF     = 'https://i.ibb.co/9MD2Zxs/In-Shot-20260831-123928524.gif';         // successful missile launch
const MISSILE_FAIL_GIF= 'https://i.ibb.co/QFsFQH23/ezgif-com-crop-3.gif';                  // missile utter failure / intercepted
const NUKE_GIF        = 'https://i.ibb.co/RpP5fFB4/d75784-56c70b35d16549ff87ecdea76d588e79-mv2.gif'; // successful nuke launch
const NUKE_FAIL_GIF   = 'https://i.ibb.co/sdy4GPSb/In-Shot-20260831-144508703.gif';        // nuke utter failure / intercepted
const AIRVGROUND_GIF  = 'https://i.ibb.co/4gs5F5rq/In-Shot-20260901-041723412.gif';        // airstrikes on soldiers and tanks
const NAVAL_FAIL_GIF  = 'https://i.ibb.co/HSF4dDx/yamato-sinking-ship.gif';                // naval utter failure (ship sinking)
const GROUND_FAIL_GIF = 'https://i.ibb.co/Kxb0QS5h/1917-explosion.gif';                    // ground attack utter failure
const AIR_FAIL_GIF    = 'https://i.ibb.co/FLTPn67b/plummet-fall.gif';                      // aircraft/airstrike utter failure (plane going down)

// ── Not yet replaced — verified real-footage Giphy links from before ──
const FORTIFY_GIF     = 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExM3dyaDZqbXJjMGwyMDRoNTN3M2tkYTRkZnk0dmd5aXNtb2xwZHNxcyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/l3vR80tqnUBaZx50A/giphy.gif'; // best-effort match, not a perfect thematic fit
const PEACE_GIF       = 'https://media1.tenor.com/m/ObWFgyjIM4QAAAAd/peace-dove.gif'; // not yet re-verified as a Giphy link; flag if this fails to render

const GIFS = {
  GROUND:       { UTTER_FAILURE: [GROUND_FAIL_GIF], default: [GROUND_GIF] },
  AIRVINFRA:    { UTTER_FAILURE: [AIR_FAIL_GIF], default: [AIRSTRIKE_GIF] },
  AIRVSOLDIERS: { UTTER_FAILURE: [AIR_FAIL_GIF], default: [AIRVGROUND_GIF] },
  AIRVTANKS:    { UTTER_FAILURE: [AIR_FAIL_GIF], default: [AIRVGROUND_GIF] },
  AIRVMONEY:    { UTTER_FAILURE: [AIR_FAIL_GIF], default: [AIRSTRIKE_GIF] },
  AIRVSHIPS:    { UTTER_FAILURE: [AIR_FAIL_GIF], default: [AIRSTRIKE_GIF] },
  AIRVAIR:      { UTTER_FAILURE: [AIR_FAIL_GIF], default: [DOGFIGHT_GIF] },
  NAVAL:        { UTTER_FAILURE: [NAVAL_FAIL_GIF], default: [NAVAL_GIF] },
  NAVALVSHIPS:  { UTTER_FAILURE: [NAVAL_FAIL_GIF], default: [NAVAL_GIF] },
  NAVALVINFRA:  { UTTER_FAILURE: [NAVAL_FAIL_GIF], default: [NAVAL_GIF] },
  NAVALVMONEY:  { UTTER_FAILURE: [NAVAL_FAIL_GIF], default: [NAVAL_GIF] }, // not yet confirmed live, added defensively to match the AIRV* naming pattern
  MISSILE:      { UTTER_FAILURE: [MISSILE_FAIL_GIF], default: [MISSILE_GIF] },
  MISSILEFAIL:  { default: [MISSILE_FAIL_GIF] },
  NUKE:         { UTTER_FAILURE: [NUKE_FAIL_GIF], default: [NUKE_GIF] },
  NUKEFAIL:     { default: [NUKE_FAIL_GIF] },
  FORTIFY:      { default: [FORTIFY_GIF] },
  PEACE:        { default: [PEACE_GIF] },
  VICTORY:      { default: [GROUND_GIF] },
  ALLIANCELOOT: { default: [GROUND_GIF] },
};

// Old key names -> canonical enum key, kept so nothing breaks if the API
// naming differs from what's confirmed above.
const TYPE_ALIASES = {
  AIRSTRIKE_INFRA: 'AIRVINFRA', AIRSTRIKE_SOLDIERS: 'AIRVSOLDIERS', AIRSTRIKE_TANKS: 'AIRVTANKS',
  AIRSTRIKE_MONEY: 'AIRVMONEY', AIRSTRIKE_SHIP: 'AIRVSHIPS', AIRSTRIKE_AIR: 'AIRVAIR',
  NAVAL_INFRA: 'NAVAL',
};
function normalizeAttackType(type) {
  return TYPE_ALIASES[type] || type;
}

function getGif(attackType, successOutcome) {
  const type = normalizeAttackType(attackType);
  const typeGifs = GIFS[type];
  if (!typeGifs) return null;
  const key = successOutcome==null ? '' : String(successOutcome); // defensive: success can be an Int code, not a string
  let pool = typeGifs[key];
  if (!pool) pool = typeGifs.default;
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { getGif, GIFS, normalizeAttackType };
