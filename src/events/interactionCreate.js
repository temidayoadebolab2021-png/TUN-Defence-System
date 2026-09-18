// ============================================================
// src/events/interactionCreate.js
// War Status button now deletes old card and reposts at bottom pinned
// ============================================================

const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('../utils/logger');
const { checkPermission } = require('../utils/permissions');
const { run, queryOne } = require('../utils/database');
const { buildWarButtons, fetchWarData, fetchNationData, sendUnifiedWarCard } = require('../systems/military/warRoomManager');
const { getAllianceMembers } = require('../utils/pwApi');
const { buildNationToDiscordMap } = require('../utils/nationLink');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {

    // ── SLASH COMMANDS ─────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      if (command.requiredRole && !checkPermission(interaction, command.requiredRole)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 });
      }
      try {
        await command.execute(interaction, client);
      } catch (error) {
        logger.error(`Error in /${interaction.commandName}: ${error.stack || error.message}`);
        const msg = { content: '❌ Something went wrong. The error has been logged.', flags: 64 };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
      return;
    }

    if (!interaction.isButton()) return;
    const { customId } = interaction;

    if (customId.startsWith('assignment_accept_'))   return handleAssignmentAccept(interaction, parseInt(customId.replace('assignment_accept_','')), client);
    if (customId.startsWith('assignment_decline_'))  return handleAssignmentDecline(interaction, parseInt(customId.replace('assignment_decline_','')), client);
    if (customId.startsWith('assignment_complete_')) return handleAssignmentComplete(interaction, parseInt(customId.replace('assignment_complete_','')), client);
    if (customId.startsWith('war_claim_'))   return handleWarClaim(interaction, customId.replace('war_claim_',''), client);
    if (customId.startsWith('war_status_'))  return handleWarStatus(interaction, customId.replace('war_status_',''), client);
    if (customId.startsWith('war_counter_')) return handleWarCounter(interaction, customId.replace('war_counter_',''), client);
    if (customId.startsWith('war_spies_'))   return handleWarSpies(interaction, customId.replace('war_spies_',''), client);
  },
};

// ── WAR CLAIM ────────────────────────────────────────────────
async function handleWarClaim(interaction, roomId, client) {
  try {
    await interaction.deferReply({ flags: 64 });
    const room = queryOne('SELECT * FROM war_rooms WHERE id=? AND status=?', [roomId, 'active']);
    if (!room) return interaction.editReply('❌ This is not an active war room.');

    const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [interaction.guildId]);
    if (milRole?.discord_role_id && !interaction.member.roles.cache.has(milRole.discord_role_id)) {
      return interaction.editReply(`❌ Only members with the <@&${milRole.discord_role_id}> role can claim a war room.`);
    }

    run('UPDATE war_rooms SET director_discord_id=? WHERE id=?', [interaction.user.id, room.id]);

    const updatedRoom = queryOne('SELECT * FROM war_rooms WHERE id=?', [room.id]);
    await sendUnifiedWarCard(interaction.channel, updatedRoom);

    await interaction.editReply('✅ You are now the **Director** of this war room.');
    await interaction.channel.send({ content: `🎖️ <@${interaction.user.id}> has claimed command of this war room.` });
  } catch (err) {
    logger.error(`War claim error: ${err.message}`);
    await interaction.editReply('❌ Something went wrong.').catch(() => {});
  }
}

// ── WAR STATUS / REFRESH — rebuilds the unified card for EVERY member ─
async function handleWarStatus(interaction, roomId, client) {
  try {
    await interaction.deferReply({ flags: 64 });
    const room = queryOne('SELECT * FROM war_rooms WHERE id=?', [roomId]);
    if (!room) return interaction.editReply('❌ This is not a war room.');

    await sendUnifiedWarCard(interaction.channel, room);
    await interaction.editReply('✅ War card refreshed — check the bottom of the channel (it\'s pinned).');
  } catch (err) {
    logger.error(`War status error: ${err.message}`);
    await interaction.editReply('❌ Something went wrong.').catch(() => {});
  }
}

// ── WAR COUNTER ──────────────────────────────────────────────
async function handleWarCounter(interaction, warId, client) {
  try {
    await interaction.deferReply({ flags: 64 });
    const room     = queryOne('SELECT * FROM war_rooms WHERE channel_id=?', [interaction.channelId]);
    if (!room) return interaction.editReply('❌ This is not a war room.');
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
    if (!guildRow?.alliance_id) return interaction.editReply('❌ No alliance configured.');

    const [enemyData, ourMembers] = await Promise.all([fetchNationData(room.enemy_nation_id), getAllianceMembers(guildRow.alliance_id)]);
    if (!enemyData) return interaction.editReply('❌ Could not fetch enemy data.');

    const discordMap = buildNationToDiscordMap(interaction.guildId);
    // War range: member.score must be within enemy.score/1.5 to enemy.score/0.75
    // (target's score within 75%-150% of the member's own score, solved for member.score)
    const min = (enemyData.score||0) / 1.5, max = (enemyData.score||0) / 0.75;
    const eligible = ourMembers
      .filter(m => m.score >= min && m.score <= max && (m.vacation_mode_turns||0) === 0 && (m.offensive_wars_count||0) < 5)
      .sort((a, b) => (b.aircraft||0) - (a.aircraft||0));

    if (eligible.length === 0) return interaction.editReply('❌ No members in war range with open slots.');

    const lines = eligible.slice(0, 15).map(m => {
      const dId = discordMap.get(m.id) || discordMap.get(String(m.id));
      return `${dId ? `<@${dId}>` : `**${m.nation_name}**`} — [${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})\n└ Score: ${Math.round(m.score).toLocaleString()} | 👮 ${(m.soldiers||0).toLocaleString()} | 🚗 ${(m.tanks||0).toLocaleString()} | ✈️ ${m.aircraft||0} | 🚢 ${m.ships||0} | Slots: **${5-(m.offensive_wars_count||0)}**`;
    });

    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`⚔️ Counter Options vs ${enemyData.nation_name}`).setColor(0xe74c3c).setDescription(lines.join('\n\n')).addFields({ name: '📏 War Range', value: `${Math.round(min).toLocaleString()} – ${Math.round(max).toLocaleString()}`, inline: true }).setFooter({ text: `${eligible.length} eligible` }).setTimestamp()] });
  } catch (err) {
    logger.error(`War counter error: ${err.message}`);
    await interaction.editReply('❌ Something went wrong.').catch(() => {});
  }
}

// ── WAR SPIES ────────────────────────────────────────────────
async function handleWarSpies(interaction, warId, client) {
  try {
    await interaction.deferReply({ flags: 64 });
    const room     = queryOne('SELECT * FROM war_rooms WHERE channel_id=?', [interaction.channelId]);
    if (!room) return interaction.editReply('❌ This is not a war room.');
    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
    if (!guildRow?.alliance_id) return interaction.editReply('❌ No alliance configured.');

    const [enemyData, ourMembers] = await Promise.all([fetchNationData(room.enemy_nation_id), getAllianceMembers(guildRow.alliance_id)]);
    if (!enemyData) return interaction.editReply('❌ Could not fetch enemy data.');

    const discordMap = buildNationToDiscordMap(interaction.guildId);
    // Official P&W spy range is -60% to +150% of score (confirmed via
    // politicsandwar.com/pwpedia), not the war-range formula this used to
    // borrow. Since 0.4 and 2.5 are reciprocals, it doesn't matter whether
    // the window is computed from the enemy's score or each member's own —
    // the eligibility check comes out identical either way.
    const min = (enemyData.score||0) * 0.4, max = (enemyData.score||0) * 2.5;
    const enemySpies = enemyData.spies||0;

    // Official espionage success formula (Normal Precautions safety level):
    // Odds = 50 + (Your Spies * 100 / (Enemy Spies * 3 + 1))
    const estimateOdds = (mySpies) => Math.min(100, Math.round(50 + ((mySpies||0) * 100) / ((enemySpies * 3) + 1)));

    const eligible = ourMembers
      .filter(m => m.score >= min && m.score <= max && (m.vacation_mode_turns||0) === 0 && (m.spies||0) > 0)
      .sort((a, b) => (b.spies||0) - (a.spies||0));

    if (eligible.length === 0) return interaction.editReply('❌ No members in spy range with active spies.');

    const lines = eligible.slice(0, 15).map(m => {
      const dId = discordMap.get(m.id) || discordMap.get(String(m.id));
      const odds = estimateOdds(m.spies);
      return `${dId ? `<@${dId}>` : `**${m.nation_name}**`} — [${m.nation_name}](https://politicsandwar.com/nation/id=${m.id})\n└ 🕵️ Spies: **${m.spies||0}** | Score: ${Math.round(m.score).toLocaleString()} | ~**${odds}%** success (Normal Precautions)`;
    });

    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🕵️ Spy Options vs ${enemyData.nation_name}`).setColor(0x8e44ad).setDescription(lines.join('\n\n')).addFields({ name: '🎯 Enemy Spies', value: `${enemySpies}`, inline: true }, { name: '📏 Spy Range', value: `${Math.round(min).toLocaleString()} – ${Math.round(max).toLocaleString()}`, inline: true }).setFooter({ text: `${eligible.length} in spy range | odds shown are an estimate at Normal Precautions safety level` }).setTimestamp()] });
  } catch (err) {
    logger.error(`War spies error: ${err.message}`);
    await interaction.editReply('❌ Something went wrong.').catch(() => {});
  }
}

// ── ASSIGNMENT ACCEPT ────────────────────────────────────────
async function handleAssignmentAccept(interaction, id, client) {
  try {
    const a = queryOne('SELECT * FROM target_assignments WHERE id=?', [id]);
    if (!a) return interaction.reply({ content:`❌ Assignment #${id} not found.`, flags:64 });
    if (a.assigned_to_discord_id !== interaction.user.id) return interaction.reply({ content:'❌ Not your assignment.', flags:64 });
    if (a.status === 'accepted') return interaction.reply({ content:'✅ Already accepted.', flags:64 });
    if (['completed','cancelled','expired'].includes(a.status)) return interaction.reply({ content:`❌ Already **${a.status}**.`, flags:64 });

    run(`UPDATE target_assignments SET status='accepted', updated_at=datetime('now') WHERE id=?`, [id]);
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`assignment_complete_${id}`).setLabel('🏆 Mark as Completed').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setLabel('🔗 View Target').setStyle(ButtonStyle.Link).setURL(`https://politicsandwar.com/nation/id=${a.target_nation_id}`),
    );
    await interaction.reply({ embeds:[new EmbedBuilder().setTitle('✅ Assignment Accepted').setColor(0x2ecc71).setDescription(`You accepted the assignment to attack **[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})**.\n\nClick **Mark as Completed** once you have declared war.`).setTimestamp()], components:[btn], flags:64 });

    try { const o = await client.users.fetch(a.assigned_by_discord_id); await o.send({ content:`✅ <@${interaction.user.id}> accepted assignment **#${id}** — **${a.target_nation_name}**` }); } catch {}

    const ch = queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='wars'`,[a.guild_id]) || queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='intel'`,[a.guild_id]);
    if (ch) { const c = client.channels.cache.get(ch.discord_channel_id); if (c) await c.send({ embeds:[new EmbedBuilder().setColor(0x2ecc71).setDescription(`✅ <@${interaction.user.id}> accepted assignment **#${id}** — **[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})**`).setTimestamp()] }); }
  } catch (err) { logger.error(`Accept error: ${err.message}`); await interaction.reply({ content:'❌ Something went wrong.', flags:64 }).catch(()=>{}); }
}

// ── ASSIGNMENT DECLINE ───────────────────────────────────────
async function handleAssignmentDecline(interaction, id, client) {
  try {
    const a = queryOne('SELECT * FROM target_assignments WHERE id=?', [id]);
    if (!a) return interaction.reply({ content:`❌ Assignment #${id} not found.`, flags:64 });
    if (a.assigned_to_discord_id !== interaction.user.id) return interaction.reply({ content:'❌ Not your assignment.', flags:64 });
    if (['completed','cancelled','expired'].includes(a.status)) return interaction.reply({ content:`❌ Already **${a.status}**.`, flags:64 });

    run(`UPDATE target_assignments SET status='cancelled', updated_at=datetime('now') WHERE id=?`, [id]);
    await interaction.reply({ content:`❌ You declined assignment **#${id}** — **${a.target_nation_name}**.`, flags:64 });
    try { const o = await client.users.fetch(a.assigned_by_discord_id); await o.send({ embeds:[new EmbedBuilder().setTitle('❌ Assignment Declined').setColor(0xe74c3c).addFields({name:'👤 Declined By',value:`<@${interaction.user.id}>`,inline:true},{name:'🎯 Target',value:`[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})`,inline:true},{name:'⚡ Action',value:'Please reassign.',inline:false}).setTimestamp()] }); } catch {}
  } catch (err) { logger.error(`Decline error: ${err.message}`); await interaction.reply({ content:'❌ Something went wrong.', flags:64 }).catch(()=>{}); }
}

// ── ASSIGNMENT COMPLETE ──────────────────────────────────────
async function handleAssignmentComplete(interaction, id, client) {
  try {
    const a = queryOne('SELECT * FROM target_assignments WHERE id=?', [id]);
    if (!a) return interaction.reply({ content:`❌ Assignment #${id} not found.`, flags:64 });
    if (a.assigned_to_discord_id !== interaction.user.id) return interaction.reply({ content:'❌ Not your assignment.', flags:64 });
    if (a.status === 'completed') return interaction.reply({ content:'✅ Already completed!', flags:64 });
    if (a.status === 'cancelled') return interaction.reply({ content:'❌ Assignment was cancelled.', flags:64 });

    run(`UPDATE target_assignments SET status='completed', updated_at=datetime('now') WHERE id=?`, [id]);
    await interaction.reply({ embeds:[new EmbedBuilder().setTitle('🏆 Assignment Completed!').setColor(0xf1c40f).setDescription(`Great work! Target: **[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})**`).setTimestamp()], flags:64 });

    try { const o = await client.users.fetch(a.assigned_by_discord_id); await o.send({ content:`🏆 <@${interaction.user.id}> completed **#${id}** — **${a.target_nation_name}**` }); } catch {}

    const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`,[a.guild_id]);
    const ch = queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='wars'`,[a.guild_id]) || queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='intel'`,[a.guild_id]);
    if (ch) { const c = client.channels.cache.get(ch.discord_channel_id); if (c) await c.send({ content:govRole?`<@&${govRole.discord_role_id}>`:undefined, embeds:[new EmbedBuilder().setColor(0xf1c40f).setTitle('🏆 Target Eliminated!').setDescription(`<@${interaction.user.id}> completed **#${id}** — **[${a.target_nation_name}](https://politicsandwar.com/nation/id=${a.target_nation_id})**`).setTimestamp()] }); }
  } catch (err) { logger.error(`Complete error: ${err.message}`); await interaction.reply({ content:'❌ Something went wrong.', flags:64 }).catch(()=>{}); }
}
