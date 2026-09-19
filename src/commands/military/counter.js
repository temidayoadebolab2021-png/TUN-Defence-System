// ============================================================
// src/commands/military/counter.js
// Detect when alliance members are attacked and assign counters
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { resolveNation, getAllianceMembers, getNationWars } = require('../../utils/pwApi');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('counter')
    .setDescription('Manage counter-attack assignments')

    .addSubcommand(sub =>
      sub.setName('find')
        .setDescription('Find alliance members who can counter-attack a specific attacker')
        .addStringOption(opt =>
          opt.setName('attacker')
            .setDescription('The enemy nation attacking us — name, ID, or P&W link')
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub.setName('assign')
        .setDescription('Assign a member to counter a specific enemy attacker')
        .addStringOption(opt =>
          opt.setName('attacker')
            .setDescription('Enemy nation to counter — name, ID, or P&W link')
            .setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('member')
            .setDescription('Alliance member to do the counter')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('notes')
            .setDescription('Instructions for the counter (optional)')
        )
    )

    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check which alliance members are currently being attacked')
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── FIND ────────────────────────────────────────────────
    if (sub === 'find') {
      await interaction.deferReply();
      try {
        const input = interaction.options.getString('attacker');

        await interaction.editReply(`🔍 Looking up **${input}**...`);

        const attacker = await resolveNation(input);
        if (!attacker) {
          return interaction.editReply(`❌ Could not find nation **"${input}"**. Try the exact name, ID, or P&W link.`);
        }

        const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
        if (!guildRow?.alliance_id) {
          return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
        }

        // Get our members (no applicants)
        const members = await getAllianceMembers(guildRow.alliance_id);

        // War range: a nation can declare on targets whose score is within
        // 75%-150% of their own. Solved for "which of our members can hit
        // this specific enemy": member.score must be between
        // enemy.score/1.5 and enemy.score/0.75. (The previous /1.75 lower
        // bound didn't correspond to any consistent percentage rule and let
        // through members who were actually out of real war range.)
        const minScore = attacker.score / 1.5;
        const maxScore = attacker.score / 0.75;

        const eligible = members.filter(m => {
          if (m.score < minScore || m.score > maxScore) return false;
          if (m.vacation_mode_turns > 0) return false;
          if (m.offensive_wars_count >= 5) return false;
          return true;
        }).map(m => ({ ...m, openSlots: 5 - m.offensive_wars_count }))
          // Strongest eligible counter first (higher score = more effective
          // within the same valid war-range window), open slots as tiebreaker.
          .sort((a, b) => b.score - a.score || b.openSlots - a.openSlots);

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Counter Options — ${attacker.nation_name}`)
          .setColor(0xe74c3c)
          .addFields(
            { name: '⚔️ Enemy Nation', value: `[${attacker.nation_name}](https://politicsandwar.com/nation/id=${attacker.id})`, inline: true },
            { name: '🏛️ Alliance', value: attacker.alliance?.name || 'None', inline: true },
            { name: '⭐ Score', value: attacker.score?.toLocaleString() || '?', inline: true },
            { name: '🪖 Military', value: `✈️ ${attacker.aircraft} | 🚗 ${attacker.tanks} | 👮 ${attacker.soldiers?.toLocaleString()} | 🚢 ${attacker.ships}`, inline: false },
            { name: '📏 Score Range for Counters', value: `${Math.round(minScore).toLocaleString()} – ${Math.round(maxScore).toLocaleString()}`, inline: false },
          )
          .setTimestamp();

        const discordMap = buildNationToDiscordMap(interaction.guildId);
        if (eligible.length === 0) {
          embed.addFields({ name: '❌ Eligible Counters', value: 'No alliance members are currently in range or have open slots.' });
        } else {
          // Each line is ~180 chars worst-case now that military stats are
          // included, so cap at 5 to stay safely under Discord's hard
          // 1024-char per-field limit (10 would overflow and error out).
          const MAX_SHOWN = 5;
          const lines = eligible.slice(0, MAX_SHOWN).map(m =>
            `• **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})**${discordMap.get(m.id) ? ` <@${discordMap.get(m.id)}>` : ''}\n` +
            `└ ⭐ ${Math.round(m.score).toLocaleString()} | 👮 ${(m.soldiers||0).toLocaleString()} | 🚗 ${(m.tanks||0).toLocaleString()} | ✈️ ${m.aircraft||0} | 🚢 ${m.ships||0} | 🎯 ${m.openSlots} slot(s)`
          );
          let value = lines.join('\n') + (eligible.length > MAX_SHOWN ? `\n_...and ${eligible.length - MAX_SHOWN} more in range_` : '');
          if (value.length > 1024) value = value.slice(0, 1010) + '\n_(truncated)_';
          embed.addFields({
            name: `✅ Eligible Counters (${eligible.length}) — strongest first`,
            value,
          });
        }

        embed.setFooter({ text: `Use /counter assign to assign someone | /assign create to assign as a regular target` });
        return interaction.editReply({ content: '', embeds: [embed] });
      } catch (err) {
        logger.error(`/counter find error: ${err.stack || err.message}`);
        return interaction.editReply('❌ Something went wrong looking that up. Check the bot logs for details.').catch(() => {});
      }
    }

    // ── ASSIGN ──────────────────────────────────────────────
    if (sub === 'assign') {
      await interaction.deferReply();
      const input = interaction.options.getString('attacker');
      const member = interaction.options.getUser('member');
      const notes = interaction.options.getString('notes') || null;

      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const attacker = await resolveNation(input);
      if (!attacker) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**. Try the exact name, ID, or P&W link.`);
      }

      const expiresHours = interaction.options.getInteger('expires') || 6;
      const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();
      run(
        `INSERT INTO target_assignments
         (guild_id, target_nation_id, target_nation_name, assigned_to_discord_id,
          assigned_by_discord_id, status, priority, notes, expires_at)
         VALUES (?, ?, ?, ?, ?, 'assigned', 'high', ?, ?)`,
        [interaction.guildId, attacker.id, attacker.nation_name,
         member.id, interaction.user.id,
         notes ? `[COUNTER] ${notes}` : '[COUNTER] Counter-attack assignment',
         expiresAt]
      );

      // Get the assignment ID we just created
      const newAssignment = queryOne(
        `SELECT id FROM target_assignments WHERE guild_id = ? AND target_nation_id = ? AND assigned_to_discord_id = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, attacker.id, member.id]
      );
      const assignmentId = newAssignment?.id;

      const embed = new EmbedBuilder()
        .setTitle('🛡️ Counter Assignment Created')
        .setColor(0xe74c3c)
        .addFields(
          { name: '⚔️ Counter Target',  value: `[${attacker.nation_name}](https://politicsandwar.com/nation/id=${attacker.id})`, inline: true },
          { name: '🏛️ Their Alliance',  value: attacker.alliance?.name || 'None', inline: true },
          { name: '👤 Assigned To',     value: `<@${member.id}>`, inline: true },
          { name: '⭐ Enemy Score',     value: attacker.score?.toLocaleString() || '?', inline: true },
          { name: '🪖 Enemy Military',  value: `✈️ ${attacker.aircraft || 0} | 🚗 ${attacker.tanks || 0} | 🚀 ${attacker.missiles || 0} | ☢️ ${attacker.nukes || 0}`, inline: true },
        )
        .setFooter({ text: `Assignment ID: #${assignmentId} | Click a button below to respond` })
        .setTimestamp();

      if (notes) embed.addFields({ name: '📝 Notes', value: notes });

      // Buttons for Accept / Decline
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`assignment_accept_${assignmentId}`)
          .setLabel('✅ Accept Counter')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`assignment_decline_${assignmentId}`)
          .setLabel('❌ Decline')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setLabel('🔗 View Target')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://politicsandwar.com/nation/id=${attacker.id}`),
      );

      await interaction.editReply({
        content: `🛡️ <@${member.id}> — counter assignment!`,
        embeds: [embed],
        components: [buttons],
      });

      // DM the member WITH buttons
      try {
        await member.send({
          content: `🛡️ You have a **counter assignment** in **${interaction.guild.name}**! Please accept or decline:`,
          embeds: [embed],
          components: [buttons],
        });
      } catch { /* DMs closed */ }
    }

    // ── CHECK ───────────────────────────────────────────────
    if (sub === 'check') {
      await interaction.deferReply();

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
      if (!guildRow?.alliance_id) {
        return interaction.editReply('❌ No alliance configured. Use `/config alliance` first.');
      }

      await interaction.editReply('⏳ Checking alliance for active defensive wars...');

      const members = await getAllianceMembers(guildRow.alliance_id);
      const underAttack = members.filter(m => m.defensive_wars_count > 0);

      if (underAttack.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🛡️ Alliance Defense Check')
              .setColor(0x2ecc71)
              .setDescription('✅ No alliance members are currently under attack.')
              .setTimestamp()
          ]
        });
      }

      const lines = underAttack.map(m =>
        `⚔️ **[${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})**\n` +
        `└ Defensive wars: **${m.defensive_wars_count}** | Score: ${Math.round(m.score).toLocaleString()}\n` +
        `└ [View Wars](https://politicsandwar.com/nation/id=${m.id})`
      );

      const embed = new EmbedBuilder()
        .setTitle(`⚔️ Members Under Attack — ${underAttack.length}`)
        .setColor(0xe74c3c)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /counter find [attacker] to find who can counter | /counter assign to assign' })
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};
