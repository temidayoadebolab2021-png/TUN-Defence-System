// ============================================================
// src/events/messageCreate.js
// Watches for pasted P&W espionage ("gather intelligence") reports and
// automatically replies with the target's total resource worth and an
// estimated victory-loot value.
// ============================================================

const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { parseEspionageReport, computeEspionageWorth } = require('../systems/intelligence/espionageValue');
const { searchNationByName, getLatestTradePrices } = require('../utils/pwApi');

module.exports = {
  name: Events.MessageCreate,

  async execute(message) {
    try {
      if (message.author.bot) return;
      if (!message.content) return;

      // Cheap pre-filter before running the full parser on every message.
      if (!/gathered intelligence about/i.test(message.content) || !/spies discovered/i.test(message.content)) return;

      const report = parseEspionageReport(message.content);
      if (!report) return;

      const [prices, nation] = await Promise.all([
        getLatestTradePrices().catch(err => { logger.error(`Espionage value: price fetch failed: ${err.message}`); return null; }),
        searchNationByName(report.nationName).catch(err => { logger.error(`Espionage value: nation search failed: ${err.message}`); return null; }),
      ]);

      if (!prices) {
        await message.reply({ content: `⚠️ Detected an espionage report for **${report.nationName}**, but couldn't fetch current market prices to compute worth. Try again shortly.` }).catch(()=>{});
        return;
      }

      const defenderPolicy = nation?.warpolicy || null;
      const result = computeEspionageWorth(report, prices, defenderPolicy);

      const lines = [];
      lines.push(`💰 **${report.nationName}** is worth **$${Math.round(result.totalWorth).toLocaleString()}** (cash + all resources at current market prices).`);
      lines.push('');
      lines.push(`⚔️ If raided and defeated (Victory), the base loot is **10%** of that ≈ **$${Math.round(result.baseLoot).toLocaleString()}**.`);

      if (defenderPolicy) {
        const modText = result.defenderMod > 0 ? `+${result.defenderMod}%` : result.defenderMod < 0 ? `${result.defenderMod}%` : 'no change';
        lines.push(`🛡️ Their current war policy is **${toTitleCase(defenderPolicy)}** (${modText} loot) → adjusted estimate ≈ **$${Math.round(result.defenderAdjustedLoot).toLocaleString()}**.`);
      } else {
        lines.push(`🛡️ Couldn't confirm their current war policy — the figure above assumes no policy modifier.`);
      }

      lines.push(`⚙️ This can shift further depending on **your own** war policy when you attack: Pirate (+40% loot), Attrition (−20% loot), others don't affect loot.`);

      await message.reply({ content: lines.join('\n') }).catch(()=>{});
    } catch (err) {
      logger.error(`messageCreate (espionage value) error: ${err.message}`);
    }
  },
};

function toTitleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
