// ============================================================
// src/systems/intelligence/espionageValue.js
// Detects an in-game espionage ("gather intelligence") report pasted into
// Discord, computes the target's total resource worth at current market
// prices, and estimates victory-loot (end-of-war, resistance-to-0) value.
//
// SOURCES USED (not guessed):
// - Victory loot base rate (10% of money and all resources) — confirmed
//   from politicsandwar.fandom.com/wiki/Victory: "The nation's stockpiles
//   of both money and resources are looted by the winner; 10% of money
//   and 10% of all resources... modified by War Type as well as War Policy."
// - War policy loot modifiers — provided directly by the server owner from
//   the in-game War Policy descriptions (Pirate +40%, Attrition -20%,
//   Moneybags -40%, Turtle +20%, Guardian +20%).
// - Modifiers stack ADDITIVELY (percentage points), not multiplicatively —
//   confirmed by the wiki's own worked example for the per-attack loot
//   formula: "If the defender's war policy is Moneybags... 0.6. If the
//   attacker's war policy is Pirate... 1.4. If both... they cancel each
//   other out and the WarPolicyFactor = 1" — this only works out to
//   exactly 1.0 with additive stacking (+40% + -40% = 0%), not
//   multiplicative (0.6 * 1.4 = 0.84). Carried over to victory loot since
//   the wiki states the same War Policy modifier system applies to both.
// ============================================================

const RESOURCE_NAMES = ['coal','oil','uranium','lead','iron','bauxite','gasoline','munitions','steel','aluminum','food'];

const RESOURCE_DISPLAY = {
  coal:'⚫ Coal', oil:'🛢️ Oil', uranium:'☢️ Uranium', lead:'⚙️ Lead', iron:'⛏️ Iron',
  bauxite:'🪨 Bauxite', gasoline:'⛽ Gasoline', munitions:'💣 Munitions', steel:'🔩 Steel',
  aluminum:'🔧 Aluminum', food:'🌾 Food',
};

// Loot modifier in percentage points, additive. Only policies that affect
// loot are listed — the rest (Blitzkrieg, Fortress, Tactician, Covert,
// Arcane) don't touch loot amount per the user-provided policy descriptions.
const LOOT_POLICY_MODIFIERS = {
  PIRATE:    +40, // attacker policy
  ATTRITION: -20, // attacker policy
  MONEYBAGS: -40, // defender policy
  TURTLE:    +20, // defender policy
  GUARDIAN:  +20, // defender policy
};

const BASE_LOOT_RATE = 0.10; // 10% of money + 10% of every resource, confirmed from the Victory wiki page

// Parses a pasted espionage ("gather intelligence") report. Returns
// { nationName, money, resources: {coal, oil, ...} } or null if the text
// doesn't match the expected report format.
function parseEspionageReport(text) {
  if (!text || typeof text !== 'string') return null;
  if (!/gathered intelligence about/i.test(text) || !/spies discovered/i.test(text)) return null;

  const nameMatch = text.match(/gathered intelligence about\s+([^.]+?)\.\s*Your spies discovered/i);
  if (!nameMatch) return null;
  const nationName = nameMatch[1].trim();

  const moneyMatch = text.match(/has\s+\$([\d,]+(?:\.\d+)?)/i);
  const money = moneyMatch ? parseFloat(moneyMatch[1].replace(/,/g,'')) : 0;

  const resources = {};
  const pattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s+(${RESOURCE_NAMES.join('|')})\\b`, 'gi');
  let m;
  while ((m = pattern.exec(text)) !== null) {
    resources[m[2].toLowerCase()] = parseFloat(m[1].replace(/,/g,''));
  }

  // Require at least a few resources matched — guards against a false
  // positive from some unrelated message that happens to mention both
  // trigger phrases.
  if (Object.keys(resources).length < 5) return null;

  return { nationName, money, resources };
}

// Computes total worth and victory-loot estimate. `prices` is a Tradeprice
// snapshot ({coal, oil, ...}), `defenderPolicy` is the target's current
// warpolicy string (e.g. "GUARDIAN") or null/undefined if unknown.
function computeEspionageWorth(report, prices, defenderPolicy) {
  let totalWorth = report.money || 0;
  const breakdown = [];
  for (const key of RESOURCE_NAMES) {
    const qty = report.resources[key] || 0;
    const price = prices?.[key] || 0;
    const value = qty * price;
    totalWorth += value;
    if (qty > 0) breakdown.push({ key, qty, price, value });
  }

  const baseLoot = totalWorth * BASE_LOOT_RATE;

  const defenderMod = LOOT_POLICY_MODIFIERS[String(defenderPolicy||'').toUpperCase()] || 0;
  const defenderAdjustedLoot = baseLoot * (1 + defenderMod / 100);

  return { totalWorth, baseLoot, defenderMod, defenderAdjustedLoot, breakdown };
}

module.exports = { parseEspionageReport, computeEspionageWorth, LOOT_POLICY_MODIFIERS, BASE_LOOT_RATE, RESOURCE_DISPLAY };
