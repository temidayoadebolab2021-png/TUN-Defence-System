// ============================================================
// src/events/messageCreate.js
// Watches for pasted P&W espionage ("gather intelligence") reports and
// automatically replies with the target's total resource worth and an
// estimated victory-loot value — adjusted for both the target's current
// war policy AND the poster's own (if their Discord account is linked).
// ============================================================

const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { parseEspionageReport, computeEspionageWorth } = require('../systems/intelligence/espionageValue');
const { searchNationByName, getNation, getLatestTradePrices } = require('../utils/pwApi');
const { getLinkedNation } = require('../utils/nationLink');

module.exports = {
  name: Events.MessageCreate,

  async execute(message) {
    try {
      if (message.author.bot) return;
      if (!message.content) return;

      if (!/gathered intelligence about/i.test(message.content) || !/spies discovered/i.test(message.content)) return;

      const report = parseEspionageReport(message.content);
      if (!report) return;

      const posterLink = message.guildId ? getLinkedNation(message.guildId, message.author.id) : null;

      const [prices, targetNation, posterNation] = await Promise.all([
        getLatestTradePrices().catch(err => { logger.error(`Espionage value: price fetch failed: ${err.message}`); return null; }),
        searchNationByName(report.nationName).catch(err => { logger.error(`Espionage value: nation search failed: ${err.message}`); return null; }),
        posterLink?.nation_id ? getNation(posterLink.nation_id).catch(err => { logger.error(`Espionage value: poster nation fetch failed: ${err.message}`); return null; }) : Promise.resolve(null),
      ]);

      if (!prices) {
        await message.reply({ content: `⚠️ Detected an espionage report for **${report.nationName}**, but couldn't fetch current market prices to compute worth. Try again shortly.` }).catch(()=>{});
        return;
      }

      const defenderPolicy = targetNation?.warpolicy || null;
      const attackerPolicy = posterNation?.warpolicy || null;
      const result = computeEspionageWorth(report, prices, defenderPolicy, attackerPolicy);

      const lines = [];
      lines.push(`💰 **${report.nationName}** is worth **$${Math.round(result.totalWorth).toLocaleString()}** (cash + all resources at current market prices).`);
      lines.push('');
      lines.push(`⚔️ If raided and defeated (Victory), the base loot is **10%** of that ≈ **$${Math.round(result.baseLoot).toLocaleString()}**.`);

      if (defenderPolicy) {
        lines.push(`🛡️ Their current war policy is **${toTitleCase(defenderPolicy)}** (${fmtMod(result.defenderMod)}).`);
      } else {
        lines.push(`🛡️ Couldn't confirm their current war policy.`);
      }

      if (attackerPolicy) {
        lines.push(`⚙️ Your current war policy is **${toTitleCase(attackerPolicy)}** (${fmtMod(result.attackerMod)}).`);
      } else if (posterLink) {
        lines.push(`⚙️ Couldn't confirm your current war policy.`);
      } else {
        lines.push(`⚙️ Link your nation with \`/link\` so the bot can also factor in your own war policy.`);
      }

      if (defenderPolicy || attackerPolicy) {
        lines.push(`📊 **Adjusted estimate ≈ $${Math.round(result.adjustedLoot).toLocaleString()}** (net ${fmtMod(result.totalMod)}).`);
      } else {
        lines.push(`📊 This figure assumes no policy modifier on either side — the real number will shift once policies are known.`);
      }

      await message.reply({ content: lines.join('\n') }).catch(()=>{});
    } catch (err) {
      logger.error(`messageCreate (espionage value) error: ${err.message}`);
    }
  },
};

function fmtMod(mod) {
  if (mod > 0) return `+${mod}% loot`;
  if (mod < 0) return `${mod}% loot`;
  return 'no change';
}

function toTitleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
