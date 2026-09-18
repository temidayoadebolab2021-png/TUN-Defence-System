// ============================================================
// src/systems/defense/warMonitor.js
// CRITICAL FIX: removed att_map/def_map (not in P&W API)
// MAP is available in warattacks query but NOT in wars query
// ============================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, getAllianceMembers, MEMBER_POSITIONS } = require('../../utils/pwApi');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { isLegitimateCounter, syncTreatiesFromPW } = require('../../utils/counterDetector');
const { removeMemberFromWarRoom, isInactiveNation, daysSinceActive, closeWarRoomForInactivity } = require('../military/warRoomManager');
const logger = require('../../utils/logger');

const checking       = new Set();
const lastTreatySync = new Map();

async function checkAllianceDefense(client) {
  const guilds = query('SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
  for (const guild of guilds) {
    if (checking.has(guild.guild_id)) continue;
    checking.add(guild.guild_id);
    try {
      await processGuildWars(client, guild.guild_id, guild.alliance_id);
    } finally {
      checking.delete(guild.guild_id);
    }
  }
}

async function processGuildWars(client, guildId, allianceId) {
  try {
    // Treaty sync — at most once per hour (in-memory)
    const now      = Date.now();
    const lastSync = lastTreatySync.get(guildId) || 0;
    if (now - lastSync > 60 * 60 * 1000) {
      await syncTreatiesFromPW(guildId, allianceId);
      lastTreatySync.set(guildId, now);
    }

    const channelRow =
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='wars'`, [guildId]) ||
      queryOne(`SELECT discord_channel_id FROM guild_channels WHERE guild_id=? AND channel_type='intel'`, [guildId]);
    if (!channelRow) return;
    const alertChannel = client.channels.cache.get(channelRow.discord_channel_id);
    if (!alertChannel) return;

    // NOTE: att_map/def_map do NOT exist on the wars query in P&W API
    // Resistance fields ARE available
    const data = await pwQuery(`
      query GetAllianceWars($allianceId:[Int]) {
        wars(alliance_id:$allianceId, active:true, first:100) {
          data {
            id att_alliance_id def_alliance_id attid defid
            att_resistance def_resistance
            turnsleft
            attacker {
              id nation_name score alliance_position last_active
              soldiers tanks aircraft ships missiles nukes spies
              alliance { id name }
            }
            defender {
              id nation_name score alliance_position last_active
              soldiers tanks aircraft ships missiles nukes spies
              alliance { id name }
            }
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });

    const allWars     = data?.wars?.data || [];
    const allianceStr = String(allianceId);
    const discordMap  = buildNationToDiscordMap(guildId);

    let ourMembers = [];
    try { ourMembers = await getAllianceMembers(allianceId); } catch {}

    const discordGuild = [...client.guilds.cache.values()].find(g => {
      const row = queryOne('SELECT guild_id FROM guilds WHERE guild_id=?', [g.id]);
      return row?.guild_id === guildId;
    });

    // Check war room config ONCE per cycle
    const catRow          = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [guildId]);
    const warRoomsEnabled = !!catRow;
    if (!warRoomsEnabled) {
      logger.debug(`War rooms not configured for guild ${guildId} — run /warroom setup`);
    }

    for (const war of allWars.filter(w => String(w.def_alliance_id) === allianceStr)) {
      await processWar(client, discordGuild, guildId, allianceId, war, false, alertChannel, discordMap, ourMembers, warRoomsEnabled);
    }
    for (const war of allWars.filter(w => String(w.att_alliance_id) === allianceStr)) {
      await processWar(client, discordGuild, guildId, allianceId, war, true, alertChannel, discordMap, ourMembers, warRoomsEnabled);
    }

    await checkEndedWars(client, discordGuild, guildId, allWars);
    await checkInactiveWarRooms(client, discordGuild, guildId, allWars);

  } catch (err) {
    logger.error(`War monitor error for guild ${guildId}: ${err.message}`);
  }
}

async function processWar(client, guild, guildId, allianceId, war, isOffensive, alertChannel, discordMap, ourMembers, warRoomsEnabled) {
  const ourNation   = isOffensive ? war.attacker : war.defender;
  const enemyNation = isOffensive ? war.defender : war.attacker;
  if (!ourNation || !enemyNation) return;
  if (!MEMBER_POSITIONS.includes((ourNation.alliance_position || '').toUpperCase())) return;

  const warKey = `war_${guildId}_${war.id}_${isOffensive ? 'off' : 'def'}`;
  const seen   = queryOne(`SELECT id FROM alert_settings WHERE guild_id=? AND alert_type='war_seen' AND setting_key=?`, [guildId, warKey]);
  if (seen) return;
  run(`INSERT OR IGNORE INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_seen',?,datetime('now'))`, [guildId, warKey]);

  const counterResult = await isLegitimateCounter(guildId, allianceId, enemyNation.id, enemyNation.alliance?.id);
  const isCounter     = counterResult.isCounter;
  const counterDetail = counterResult.detail;

  if (isOffensive && !isCounter) {
    const dnrEntry = queryOne('SELECT * FROM dnr_list WHERE guild_id=? AND alliance_id=?', [guildId, parseInt(enemyNation.alliance?.id || 0)]);
    if (dnrEntry) return;
  }

  const ourDiscordId = discordMap.get(ourNation.id) || discordMap.get(String(ourNation.id));

  // NOTE: War room creation is intentionally NOT done here anymore.
  // This passive monitor runs every 60s across the whole alliance, and on any
  // restart/fresh state it would otherwise treat every pre-existing active war
  // as "new" and mass-create a room for each one (hit Discord's 50-channel-
  // per-category cap in testing). Room creation is now an explicit action via
  // `/warroom sync` (creates rooms for active wars not yet tracked) — this
  // function still handles defense pings, counter alerts, and cleanup of
  // rooms whose wars have ended (see checkEndedWars below).

  if (!isOffensive) {
    await sendDefenseAlert(alertChannel, guildId, war, ourNation, enemyNation, ourDiscordId, ourMembers, discordMap, isCounter, counterDetail);
  } else if (isCounter) {
    await alertChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`🔄 Counter War — ${ourNation.nation_name} → ${enemyNation.nation_name}`)
        .setColor(0x2ecc71)
        .setDescription(`**${ourNation.nation_name}** declared a legitimate counter.\n_${counterDetail}_\n\n[View War](https://politicsandwar.com/nation/war/timeline/war=${war.id})`)
        .setTimestamp()],
    }).catch(() => {});
  }
}

async function sendDefenseAlert(channel, guildId, war, defender, attacker, defDiscordId, ourMembers, discordMap, isCounter, counterDetail) {
  try {
    const roleRow    = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
    const ping       = roleRow ? `<@&${roleRow.discord_role_id}>` : '';
    const defMention = defDiscordId ? `<@${defDiscordId}>` : `**${defender.nation_name}**`;

    // War range: member.score must be within attacker.score/1.5 to attacker.score/0.75
    const minScore = (attacker.score || 0) / 1.5;
    const maxScore = (attacker.score || 0) / 0.75;
    const counters = ourMembers
      .filter(m => m.score >= minScore && m.score <= maxScore && (m.vacation_mode_turns||0) === 0 && (m.offensive_wars_count||0) < 5)
      .sort((a, b) => (5-(b.offensive_wars_count||0)) - (5-(a.offensive_wars_count||0)))
      .slice(0, 5)
      .map(m => {
        const dId = discordMap.get(m.id) || discordMap.get(String(m.id));
        return `• ${dId ? `<@${dId}>` : `**${m.nation_name}**`} — Score: ${Math.round(m.score).toLocaleString()} | ✈️ ${m.aircraft||0} | ${5-(m.offensive_wars_count||0)} slot(s)`;
      });

    const embed = new EmbedBuilder()
      .setTitle(isCounter ? '🔄 Counter — Member Under Attack!' : '🆘 Member Under Attack!')
      .setColor(isCounter ? 0x2ecc71 : 0xe74c3c)
      .setDescription(isCounter && counterDetail ? `✅ _${counterDetail}_` : null)
      .addFields(
        { name: '🛡️ Our Member',     value: `**[${defender.nation_name}](https://politicsandwar.com/nation/id=${defender.id})**\nScore: ${defender.score?.toLocaleString()||'?'}\n❤️ Resistance: **${(isCounter ? war.def_resistance : war.att_resistance) ?? '?'}/100**`, inline: true },
        { name: '🪖 Their Military', value: `👮 ${(defender.soldiers||0).toLocaleString()} | 🚗 ${(defender.tanks||0).toLocaleString()} | ✈️ ${defender.aircraft||0} | 🚢 ${defender.ships||0}\n🚀 ${defender.missiles||0} | ☢️ ${defender.nukes||0}`, inline: true },
        { name: '\u200b', value: '\u200b', inline: false },
        { name: '⚔️ Attacker',       value: `**[${attacker.nation_name}](https://politicsandwar.com/nation/id=${attacker.id})**\nAlliance: ${attacker.alliance?.name||'None'}\nScore: ${attacker.score?.toLocaleString()||'?'}\n❤️ Resistance: **${(isCounter ? war.att_resistance : war.def_resistance) ?? '?'}/100**`, inline: true },
        { name: '🪖 Enemy Military', value: `👮 ${(attacker.soldiers||0).toLocaleString()} | 🚗 ${(attacker.tanks||0).toLocaleString()} | ✈️ ${attacker.aircraft||0} | 🚢 ${attacker.ships||0}\n🚀 ${attacker.missiles||0} | ☢️ ${attacker.nukes||0}`, inline: true },
        { name: `✅ Eligible Counters (${counters.length})`, value: counters.length > 0 ? counters.join('\n') : '❌ No members in range', inline: false },
      )
      .setFooter({ text: `War ID: ${war.id} | MAP not available via API — check war page` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View War').setStyle(ButtonStyle.Link).setURL(`https://politicsandwar.com/nation/war/timeline/war=${war.id}`),
      new ButtonBuilder().setLabel('View Attacker').setStyle(ButtonStyle.Link).setURL(`https://politicsandwar.com/nation/id=${attacker.id}`),
    );

    await channel.send({ content: `${ping} ${defMention} — ${isCounter ? '🔄 Counter war!' : '🆘 Under attack!'}`, embeds: [embed], components: [row] });
  } catch (err) {
    logger.error(`Defense alert error: ${err.message}`);
  }
}

async function checkEndedWars(client, guild, guildId, activeWars) {
  try {
    const activeWarIds = new Set(activeWars.map(w => String(w.id)));
    const members = query(
      `SELECT wrm.*, wr.channel_id FROM war_room_members wrm JOIN war_rooms wr ON wr.id=wrm.war_room_id WHERE wr.guild_id=? AND wr.status='active'`,
      [guildId]
    ).rows;
    if (!guild || members.length === 0) return;
    for (const member of members) {
      if (!member.war_id) continue; // planned/manually-added member, not tied to a specific war — never auto-removed here
      if (!activeWarIds.has(String(member.war_id))) {
        await removeMemberFromWarRoom(client, guild, guildId, member.nation_id, member.war_id);
      }
    }
  } catch (err) {
    logger.error(`checkEndedWars error: ${err.message}`);
  }
}

// Closes war rooms whose enemy has gone inactive for 5+ days — these are
// almost always abandoned raid targets, not real ongoing fights.
async function checkInactiveWarRooms(client, guild, guildId, allWars) {
  try {
    if (!guild) return;
    const rooms = query(`SELECT * FROM war_rooms WHERE guild_id=? AND status='active'`, [guildId]).rows;
    if (rooms.length === 0) return;

    const lastActiveByNation = new Map();
    for (const w of allWars) {
      if (w.attacker) lastActiveByNation.set(String(w.attacker.id), w.attacker.last_active);
      if (w.defender) lastActiveByNation.set(String(w.defender.id), w.defender.last_active);
    }

    for (const room of rooms) {
      if (room.room_type === 'planned') continue; // manually created rooms are only ever closed manually, never auto-closed for inactivity
      const lastActive = lastActiveByNation.get(String(room.enemy_nation_id));
      if (lastActive === undefined) continue; // war ended this cycle — checkEndedWars already handles that path
      if (isInactiveNation(lastActive)) {
        await closeWarRoomForInactivity(client, guild, room, daysSinceActive(lastActive));
      }
    }
  } catch (err) {
    logger.error(`checkInactiveWarRooms error: ${err.message}`);
  }
}

module.exports = { checkAllianceDefense };
