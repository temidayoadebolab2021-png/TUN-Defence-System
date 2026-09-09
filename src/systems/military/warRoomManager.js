// ============================================================
// src/systems/military/warRoomManager.js
// Fixed: removed att_map/def_map (not in P&W API)
// MAP shown as N/A — fetch from war page directly
// ============================================================

const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, run, queryOne } = require('../../utils/database');
const { pwQuery, MEMBER_POSITIONS, getNation, searchNationByName, getNationWars } = require('../../utils/pwApi');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const { isLegitimateCounter } = require('../../utils/counterDetector');
const { getGif, normalizeAttackType } = require('../../utils/attackGifs');
const logger = require('../../utils/logger');

// Enemy nations inactive this many days are treated as raids/abandoned
// accounts — we don't want war rooms for those.
const INACTIVITY_DAYS = 5;

// P&W DateTime fields come back as "Y-m-d H:i:s" in UTC with no timezone
// suffix — append Z so JS parses it as UTC instead of local time.
function daysSinceActive(lastActiveStr) {
  if (!lastActiveStr) return null;
  const iso = lastActiveStr.includes('T') ? lastActiveStr : lastActiveStr.replace(' ', 'T') + 'Z';
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  return (Date.now() - then.getTime()) / 86400000;
}

function isInactiveNation(lastActiveStr, days = INACTIVITY_DAYS) {
  const d = daysSinceActive(lastActiveStr);
  return d !== null && d >= days;
}

async function closeWarRoomForInactivity(client, guild, room, daysInactive) {
  try {
    const channel = guild?.channels.cache.get(room.channel_id);
    if (channel) {
      await channel.send({ content: `🚫 Closing this war room — **${room.enemy_nation_name}** has been inactive for ${Math.floor(daysInactive)}+ days (raid target, not an active fight). Deleting in 10 seconds.` }).catch(()=>{});
      setTimeout(async () => { await channel.delete().catch(()=>{}); }, 10000);
    }
    run('DELETE FROM war_room_members WHERE war_room_id=?', [room.id]);
    run('UPDATE war_rooms SET status=? WHERE id=?', ['closed', room.id]);
    logger.info(`War room closed for inactivity: ${room.enemy_nation_name} (${Math.floor(daysInactive)}d inactive)`);
  } catch (err) { logger.error(`closeWarRoomForInactivity: ${err.message}`); }
}

// ── UNIFIED WAR CARD ──────────────────────────────────────────
// One card per ROOM (not per member) listing every one of our members
// currently fighting this enemy, followed by the enemy's overview.
// Rebuilt from scratch (fresh data for everyone) on every refresh — so any
// member clicking Refresh updates the whole room's picture, not just theirs.
//
// Discord hard limits respected here: 25 fields/embed, ~6000 chars/embed,
// 10 embeds/message. If a room somehow has more members than fits even
// after paginating into 10 embeds, remaining members are dropped from the
// card with a visible warning message instead of crashing or truncating
// silently — see the `overflowed` handling in sendUnifiedWarCard.
const EMBED_FIELD_LIMIT = 24; // leave 1 slot of buffer per page
const EMBED_CHAR_BUDGET = 5500; // buffer under Discord's hard 6000 cap
const MAX_EMBEDS_PER_MESSAGE = 10;

async function buildUnifiedWarCards(room) {
  const members = query('SELECT * FROM war_room_members WHERE war_room_id=?', [room.id]).rows;
  if (members.length === 0) return { embeds: [], components: [], overflowed: false, totalMembers: 0 };

  const enemyData = await fetchNationData(room.enemy_nation_id);

  const memberResults = await Promise.all(members.map(async (m) => {
    const isPlanned = !m.war_id;
    const [warData, ourData] = await Promise.all([
      isPlanned ? Promise.resolve(null) : fetchWarData(m.war_id, m.nation_id, room.enemy_nation_id),
      m.nation_id ? fetchNationData(m.nation_id) : Promise.resolve(null),
    ]);
    return { member: m, warData, ourData, isPlanned };
  }));

  const memberFields = memberResults.map(({ member, warData, ourData, isPlanned }) => {
    const name = `${isPlanned ? '⏳' : '🛡️'} ${member.discord_user_id ? `<@${member.discord_user_id}> — ` : ''}${ourData?.nation_name || member.nation_name || 'Unknown'}`;
    const value = isPlanned
      ? [
          `⭐ NS: **${Math.round(ourData?.score||0).toLocaleString()}** | 🏙️ Cities: **${ourData?.num_cities??'?'}**`,
          `👮 ${(ourData?.soldiers||0).toLocaleString()} | 🚗 ${(ourData?.tanks||0).toLocaleString()} | ✈️ ${ourData?.aircraft||0} | 🚢 ${ourData?.ships||0}`,
          `_Planned attacker — hasn't declared yet. Card will activate automatically once they do._`,
        ].join('\n')
      : [
          `⭐ NS: **${Math.round(ourData?.score||0).toLocaleString()}** | 🏙️ Cities: **${ourData?.num_cities??'?'}**`,
          `👮 ${(ourData?.soldiers||0).toLocaleString()} | 🚗 ${(ourData?.tanks||0).toLocaleString()} | ✈️ ${ourData?.aircraft||0} | 🚢 ${ourData?.ships||0}`,
          `🚀 ${ourData?.missiles||0} | ☢️ ${ourData?.nukes||0} | 🕵️ ${ourData?.spies||0}`,
          `❤️ Resistance: **${warData?.ourResistance??'?'}/100** (enemy: **${warData?.enemyResistance??'?'}/100**) | ⏳ Turns Left: **${warData?.turnsleft??'?'}**`,
          `🎯 MAP: **${warData?.ourMAP??'?'}/12** (enemy: **${warData?.enemyMAP??'?'}/12**)`,
          `[View This War](https://politicsandwar.com/nation/war/timeline/war=${member.war_id})`,
        ].join('\n');
    return { name: name.slice(0,256), value: value.slice(0,1024), inline: false };
  });

  const enemyField = {
    name: `⚔️ Enemy — [${enemyData?.nation_name||room.enemy_nation_name||'Unknown'}](https://politicsandwar.com/nation/id=${room.enemy_nation_id}) (${enemyData?.alliance?.name||room.enemy_alliance_name||'None'})`,
    value: [
      `⭐ NS: **${Math.round(enemyData?.score||0).toLocaleString()}** | 🏙️ Cities: **${enemyData?.num_cities??'?'}**`,
      `👮 ${(enemyData?.soldiers||0).toLocaleString()} | 🚗 ${(enemyData?.tanks||0).toLocaleString()} | ✈️ ${enemyData?.aircraft||0} | 🚢 ${enemyData?.ships||0}`,
      `🚀 ${enemyData?.missiles||0} | ☢️ ${enemyData?.nukes||0} | 🕵️ ${enemyData?.spies||0}`,
      `_Resistance is per-war and shown against each member above — the enemy doesn't have one shared resistance number._`,
    ].join('\n'),
    inline: false,
  };

  // ── Paginate member fields to stay under Discord's per-embed limits ──
  const pages = [];
  let currentFields = [], currentChars = 0;
  for (const field of memberFields) {
    const fieldChars = field.name.length + field.value.length;
    if (currentFields.length >= EMBED_FIELD_LIMIT || currentChars + fieldChars > EMBED_CHAR_BUDGET) {
      pages.push(currentFields);
      currentFields = []; currentChars = 0;
    }
    currentFields.push(field);
    currentChars += fieldChars;
  }
  const enemyFieldChars = enemyField.name.length + enemyField.value.length;
  if (currentFields.length < EMBED_FIELD_LIMIT + 1 && currentChars + enemyFieldChars <= EMBED_CHAR_BUDGET) {
    currentFields.push(enemyField);
    pages.push(currentFields);
  } else {
    if (currentFields.length > 0) pages.push(currentFields);
    pages.push([enemyField]);
  }

  const overflowed = pages.length > MAX_EMBEDS_PER_MESSAGE;
  const usablePages = overflowed ? pages.slice(0, MAX_EMBEDS_PER_MESSAGE) : pages;

  const embeds = usablePages.map((fields, idx) => {
    const embed = new EmbedBuilder().setColor(0x3498db).addFields(fields).setTimestamp();
    if (idx === 0) embed.setTitle(`⚔️ War Room — ${members.length} Member${members.length===1?'':'s'} vs ${room.enemy_nation_name||'Unknown'}`);
    if (usablePages.length > 1) embed.setFooter({ text: `Page ${idx+1}/${usablePages.length}` });
    return embed;
  });

  const components = [buildWarButtons(room.id), ...buildMemberLinkButtons(members)];

  return { embeds, components, overflowed, totalMembers: members.length, shownPages: usablePages.length, totalPages: pages.length };
}

function buildMemberLinkButtons(members) {
  const rows = [];
  for (let i = 0; i < members.length && rows.length < 4; i += 5) { // max 4 extra rows (+1 action row = Discord's 5-row cap)
    const chunk = members.slice(i, i + 5);
    rows.push(new ActionRowBuilder().addComponents(
      chunk.map(m => new ButtonBuilder()
        .setLabel(`🔗 ${(m.nation_name||'War').slice(0,25)}`)
        .setStyle(ButtonStyle.Link)
        .setURL(`https://politicsandwar.com/nation/war/timeline/war=${m.war_id}`))
    ));
  }
  return rows;
}

function buildWarButtons(roomId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`war_claim_${roomId}`).setLabel('🎖️ Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`war_status_${roomId}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`war_counter_${roomId}`).setLabel('⚔️ Counter').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`war_spies_${roomId}`).setLabel('🕵️ Spies').setStyle(ButtonStyle.Secondary),
  );
}

async function sendUnifiedWarCard(channel, room) {
  try {
    if (room.card_message_id) {
      const oldMsg = await channel.messages.fetch(room.card_message_id).catch(()=>null);
      if (oldMsg) await oldMsg.delete().catch(()=>{});
    }
    const { embeds, components, overflowed, totalMembers, shownPages, totalPages } = await buildUnifiedWarCards(room);
    if (embeds.length === 0) return null;
    const newMsg = await channel.send({ embeds, components });
    await newMsg.pin().catch(()=>{});
    run('UPDATE war_rooms SET card_message_id=? WHERE id=?', [newMsg.id, room.id]);
    if (overflowed) {
      await channel.send({ content: `⚠️ This war room has **${totalMembers} members** — too many to fit on one card (Discord's embed limit). Showing ${shownPages} of ${totalPages} pages; the rest aren't displayed. Consider using \`/war\` to look up individual members not shown here.` }).catch(()=>{});
    }
    return newMsg;
  } catch (err) { logger.error(`sendUnifiedWarCard: ${err.message}`); return null; }
}

async function fetchWarData(warId, ourNationId, enemyNationId) {
  // att_points/def_points are our best-evidence guess for the MAP (Military
  // Action Points) field names — inferred from the confirmed att_resistance/
  // def_resistance naming pattern and the old v2 API's equivalent field
  // names, but NOT directly confirmed against the live v3 schema. A wrong
  // field name fails the ENTIRE GraphQL query (not just that one field, as
  // we've hit twice before in this same file), so this tries the enhanced
  // query first and falls back to the known-safe query if it errors —
  // MAP will just show as unavailable rather than breaking the whole card.
  try {
    const data = await pwQuery(`
      query W($id:[Int]){wars(id:$id,first:1){data{
        id turnsleft att_resistance def_resistance att_points def_points attid defid
      }}}
    `, { id:[parseInt(warId)] });
    const war = data?.wars?.data?.[0];
    if (war) {
      const weAtt = String(war.attid)===String(ourNationId);
      return {
        ...war,
        isOurAttack:     weAtt,
        ourNationId,
        ourResistance:   weAtt ? war.att_resistance : war.def_resistance,
        ourMAP:          weAtt ? war.att_points : war.def_points,
        enemyResistance: weAtt ? war.def_resistance : war.att_resistance,
        enemyMAP:        weAtt ? war.def_points : war.att_points,
      };
    }
  } catch (err) {
    logger.warn(`fetchWarData: att_points/def_points query failed (${err.message}) — falling back to MAP-less query. This likely means those field names are wrong; MAP will show as unavailable until corrected.`);
  }

  // Fallback — known-safe query without the unverified MAP fields.
  try {
    const data = await pwQuery(`
      query W($id:[Int]){wars(id:$id,first:1){data{
        id turnsleft att_resistance def_resistance attid defid
      }}}
    `, { id:[parseInt(warId)] });
    const war = data?.wars?.data?.[0];
    if (!war) return null;
    const weAtt = String(war.attid)===String(ourNationId);
    return {
      ...war,
      isOurAttack:     weAtt,
      ourNationId,
      ourResistance:   weAtt ? war.att_resistance : war.def_resistance,
      ourMAP:          null,
      enemyResistance: weAtt ? war.def_resistance : war.att_resistance,
      enemyMAP:        null,
    };
  } catch (err) { logger.error(`fetchWarData: ${err.message}`); return null; }
}

async function fetchNationData(nationId) {
  try {
    const data = await pwQuery(`
      query N($id:[Int]){nations(id:$id,first:1){data{
        id nation_name score num_cities soldiers tanks aircraft ships missiles nukes spies alliance{name}
      }}}
    `, { id:[parseInt(nationId)] });
    return data?.nations?.data?.[0]||null;
  } catch { return null; }
}

async function fetchNewAttacks(warId, lastAttackId) {
  const attacks = await fetchAttacksBatch([warId]);
  if (!lastAttackId) return attacks;
  return attacks.filter(a => parseInt(a.id) > parseInt(lastAttackId));
}

// Fetches attacks for MULTIPLE wars in a single API call. Politics & War's
// API has a hard DAILY quota (2,000/day standard, 5,000/day VIP) — it is
// NOT a per-minute limit. Querying once per war-room-member (the old
// behavior) burns through that quota multiple times faster than necessary
// for zero benefit, since one query can cover every active war at once.
async function fetchAttacksBatch(warIds) {
  const ids = [...new Set(warIds.map(id => parseInt(id)).filter(Boolean))];
  if (ids.length === 0) return [];

  // NOTE: previously also tried a `note` field here (the old v2 API had one
  // carrying a human-readable victory/loot sentence). Confirmed via live
  // API error on 2026-09-05 that `note` does NOT exist on WarAttack in v3
  // ("Cannot query field \"note\" on type \"WarAttack\"") — removed rather
  // than keep paying for a guaranteed-failing API call every single cycle.
  try {
    const data = await pwQuery(`
      query A($warId:[Int]){warattacks(war_id:$warId,orderBy:{column:ID,order:DESC},first:100){data{
        id war_id attid defid
        type victor success
        att_mun_used def_mun_used att_gas_used def_gas_used
        infra_destroyed infra_destroyed_value
        att_soldiers_lost def_soldiers_lost att_tanks_lost def_tanks_lost
        att_aircraft_lost def_aircraft_lost att_ships_lost def_ships_lost
        moneystolen loot_info
        date
      }}}
    `, { warId: ids });
    return data?.warattacks?.data || [];
  } catch (err) { logger.error(`fetchAttacksBatch: ${err.message}`); return []; }
}

// WarAttack.success is returned as an Int by the P&W API (confirmed by a live
// "successOutcome.includes is not a function" crash), NOT a string enum like
// "IMMENSE_TRIUMPH". It represents how many of the 3 combat rolls the attacker
// won: 0=Utter Failure, 1=Pyrrhic Victory, 2=Moderate Success, 3=Immense Triumph.
const SUCCESS_CODE_MAP = { 0:'UTTER_FAILURE', 1:'PYRRHIC_VICTORY', 2:'MODERATE_SUCCESS', 3:'IMMENSE_TRIUMPH' };
function normalizeSuccess(success) {
  if (typeof success === 'string') return success; // already a tag (defensive, in case API changes back)
  return SUCCESS_CODE_MAP[Number(success)] || 'MODERATE_SUCCESS';
}

function resolveAttackName(nationId, ctx) {
  if (String(nationId)===String(ctx?.ourNationId))   return ctx.ourNationName||'Our Member';
  if (String(nationId)===String(ctx?.enemyNationId))  return ctx.enemyNationName||'Enemy';
  return `Nation #${nationId}`;
}

// Human-friendly names for the P&W AttackType enum — nobody outside the
// game knows what "AIRVAIR" or "AIRVSHIPS" means, so we translate these
// for the war room reports.
const ATTACK_TYPE_INFO = {
  GROUND:        { emoji:'⚔️', label:'Ground Attack',              verb:'launched a ground assault on' },
  AIRVINFRA:     { emoji:'✈️', label:'Airstrike on Infrastructure', verb:'bombed the infrastructure of' },
  AIRVSOLDIERS:  { emoji:'✈️', label:'Airstrike on Soldiers',       verb:'bombed the troops of' },
  AIRVTANKS:     { emoji:'✈️', label:'Airstrike on Tanks',          verb:'bombed the tanks of' },
  AIRVMONEY:     { emoji:'✈️', label:'Airstrike on Treasury',       verb:'raided the treasury of' },
  AIRVSHIPS:     { emoji:'✈️', label:'Airstrike on Ships',          verb:'bombed the navy of' },
  AIRVAIR:       { emoji:'✈️', label:'Dogfight',                    verb:'engaged in a dogfight with' },
  NAVAL:         { emoji:'🚢', label:'Naval Attack',                verb:'launched a naval attack on' },
  NAVALVSHIPS:   { emoji:'🚢', label:'Naval Attack on Ships',        verb:'engaged the navy of' },
  NAVALVINFRA:   { emoji:'🚢', label:'Naval Attack on Infrastructure', verb:'shelled the coast of' },
  NAVALVMONEY:   { emoji:'🚢', label:'Naval Attack on Treasury',     verb:'raided the ports of' },
  MISSILE:       { emoji:'🚀', label:'Missile Strike',              verb:'fired a missile at' },
  MISSILEFAIL:   { emoji:'🛰️', label:'Missile Intercepted',         verb:'attempted a missile strike on' },
  NUKE:          { emoji:'☢️', label:'Nuclear Strike',              verb:'launched a nuke at' },
  NUKEFAIL:      { emoji:'🛡️', label:'Nuke Intercepted',            verb:'attempted a nuclear strike on' },
  FORTIFY:       { emoji:'🏰', label:'Fortify',                     verb:'fortified against' },
  PEACE:         { emoji:'🕊️', label:'Peace Offer',                 verb:'offered peace to' },
  VICTORY:       { emoji:'🏆', label:'Victory',                     verb:'claimed victory over' },
  ALLIANCELOOT:  { emoji:'💰', label:'Alliance Loot',                verb:'looted alliance funds from' },
};
function getAttackTypeInfo(rawType) {
  const type = normalizeAttackType(rawType);
  return ATTACK_TYPE_INFO[type] || { emoji:'⚔️', label:(rawType||'Unknown').replace(/_/g,' '), verb:'attacked' };
}

// P&W's `loot_info` field on WarAttack is a String whose exact serialization
// format isn't confirmed from documentation, so this parses defensively:
// tries JSON first, then a "{KEY=1,234, KEY2=56}" style map-toString format.
// Either way, if parsing fails entirely we still have `moneystolen` (a plain
// float) as a reliable fallback for at least the money figure.
const LOOT_RESOURCE_INFO = {
  MONEY:     { emoji:'💵', label:'Money',     isDollar:true },
  FOOD:      { emoji:'🌾', label:'Food' },
  COAL:      { emoji:'⚫', label:'Coal' },
  OIL:       { emoji:'🛢️', label:'Oil' },
  URANIUM:   { emoji:'☢️', label:'Uranium' },
  LEAD:      { emoji:'⚙️', label:'Lead' },
  IRON:      { emoji:'⛏️', label:'Iron' },
  BAUXITE:   { emoji:'🪨', label:'Bauxite' },
  GASOLINE:  { emoji:'⛽', label:'Gasoline' },
  MUNITIONS: { emoji:'💣', label:'Munitions' },
  STEEL:     { emoji:'🔩', label:'Steel' },
  ALUMINUM:  { emoji:'🔧', label:'Aluminum' },
};

function normalizeLootKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj||{})) {
    const key = k.toUpperCase();
    if (LOOT_RESOURCE_INFO[key]) out[key] = Number(v) || 0;
  }
  return out;
}

function parseLootInfo(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return normalizeLootKeys(parsed);
  } catch {}
  const matches = [...raw.matchAll(/([A-Za-z_]+)\s*=\s*(-?[\d,]+(?:\.\d+)?)/g)];
  if (matches.length > 0) {
    const obj = {};
    for (const [, key, val] of matches) obj[key.toUpperCase()] = parseFloat(val.replace(/,/g,''));
    return normalizeLootKeys(obj);
  }
  return null;
}

// Parses the natural-language victory sentence P&W shows on the war
// timeline page, e.g.: "Paradises looted $823,549.00, 3.00 coal, 138.00
// oil, ... and 2,363.00 food." Used against whatever field (if any) ends
// up carrying this text — see the `note` field attempt in fetchAttacksBatch.
function parseLootNote(text) {
  if (!text || typeof text !== 'string') return null;
  const out = {};
  // Not anchored to a specific preceding word — the VICTORY sentence says
  // "looted $X" but the ALLIANCELOOT sentence says "taking: $X", and these
  // sentences only ever contain one dollar figure, so a bare match is safe.
  const moneyMatch = text.match(/\$([\d,]+(?:\.\d+)?)/);
  if (moneyMatch) out.MONEY = parseFloat(moneyMatch[1].replace(/,/g,''));
  const resourceNames = Object.keys(LOOT_RESOURCE_INFO).filter(k => k !== 'MONEY');
  const pattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s+(${resourceNames.join('|')})\\b`, 'gi');
  let m;
  while ((m = pattern.exec(text)) !== null) {
    out[m[2].toUpperCase()] = parseFloat(m[1].replace(/,/g,''));
  }
  return Object.keys(out).length > 0 ? out : null;
}

function formatLootLine(lootObj) {
  if (!lootObj) return null;
  const parts = [];
  for (const [key, info] of Object.entries(LOOT_RESOURCE_INFO)) {
    const val = lootObj[key];
    if (!val) continue;
    const display = info.isDollar ? `$${Math.round(val).toLocaleString()}` : val.toLocaleString();
    parts.push(`${info.emoji} ${info.label}: **${display}**`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

function getLootLineForAttack(attack) {
  let line = formatLootLine(parseLootInfo(attack.loot_info));
  if (line) return line;
  // loot_info is actually the natural-language sentence itself (confirmed
  // via live data on 2026-09-06), not a separate structured format — the
  // earlier JSON/map-string attempt above never matches it, which is why
  // this was always falling through to "nothing was looted". This was also
  // pointed at a nonexistent `attack.note` field before; fixed to read the
  // sentence from loot_info directly.
  line = formatLootLine(parseLootNote(attack.loot_info));
  if (line) return line;
  if ((attack.moneystolen||0) > 0) return `💵 Money: **$${Number(attack.moneystolen).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}**`;
  return null;
}

// P&W logs both a peace offer AND its acceptance as separate PEACE-type
// attacks, with attid/defid REVERSED between the two (whoever accepts
// becomes the "attacker" on that record, targeting whoever originally
// offered). Without tracking this, both records get described identically
// ("X offered peace to Y") even though the second one is actually Y
// accepting X's offer. This remembers who made the last peace move in each
// war (reusing the existing alert_settings key-value table — no schema
// change needed) so the second record can be correctly described as an
// acceptance instead of a second, confusing "offer".
function resolvePeaceAction(guildId, warId, attack) {
  const key = String(warId);
  const prevRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='peace_tracker' AND setting_key=?`, [guildId, key]);
  const prevMoverId = prevRow?.setting_value;
  const isAccept = prevMoverId && String(attack.attid) !== String(prevMoverId) && String(attack.defid) === String(prevMoverId);

  run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'peace_tracker',?,?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
    [guildId, key, String(attack.attid)]);

  return isAccept ? 'accept' : 'offer';
}

// NOTE: WarAttack does NOT expose att_nation_name/def_nation_name in the P&W API
// (confirmed via live GraphQL validation error). Names are resolved from the
// war room's own known nations (ctx) instead of the attack payload.
function buildAttackReport(attack, ctx={}) {
  const successTag  = normalizeSuccess(attack.success);
  const typeInfo     = getAttackTypeInfo(attack.type);
  const attName      = resolveAttackName(attack.attid, ctx);
  const defName      = resolveAttackName(attack.defid, ctx);
  const normType     = normalizeAttackType(attack.type);
  const isPeace      = normType === 'PEACE';
  const isFortify    = normType === 'FORTIFY';
  const skipOutcome  = isPeace || isFortify;

  // A peace offer or a fortify action isn't a combat roll — "pyrrhic
  // victory" / "immense triumph" style commentary doesn't make sense
  // attached to either, so both get a plain description with no
  // success-tier language or color.
  const resultText = skipOutcome ? null
    : successTag==='UTTER_FAILURE' ? 'an **utter failure**'
    : successTag==='PYRRHIC_VICTORY' ? 'a **pyrrhic victory** — won at great cost'
    : successTag==='MODERATE_SUCCESS' ? 'a **moderate success**'
    : 'an **immense triumph**';

  const color = skipOutcome ? 0x95a5a6
    : successTag==='UTTER_FAILURE' ? 0xe74c3c
    : successTag==='PYRRHIC_VICTORY' ? 0xf39c12
    : successTag==='MODERATE_SUCCESS' ? 0x3498db
    : 0x2ecc71;

  const isPeaceAccept = isPeace && attack._peaceAction === 'accept';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(isPeaceAccept ? '🕊️ Peace Accepted' : `${typeInfo.emoji} ${typeInfo.label}`)
    .setDescription(
      isPeaceAccept
        ? `**${attName}** has accepted peace from **${defName}**.`
        : isPeace
        ? `**${attName}** ${typeInfo.verb} **${defName}**.`
        : isFortify
        ? `**${attName}** ${typeInfo.verb} **${defName}**.`
        : `**[${attName}](https://politicsandwar.com/nation/id=${attack.attid})** ${typeInfo.verb} ` +
          `**[${defName}](https://politicsandwar.com/nation/id=${attack.defid})** — it was ${resultText}!`
    );

  if ((attack.infra_destroyed||0)>0) {
    embed.addFields({ name:'🏗️ Infrastructure Destroyed', value:`${Number(attack.infra_destroyed).toFixed(2)} infra ($${Number(attack.infra_destroyed_value||0).toLocaleString()})`, inline:false });
  }

  // Ground attacks (and any other type) can loot a straight dollar amount.
  if (normType === 'GROUND') {
    const lootLine = getLootLineForAttack(attack);
    if (lootLine) embed.addFields({ name:'💰 Looted', value:lootLine, inline:false });
  }

  // VICTORY = resources looted from the defeated NATION when their
  // resistance is finished off. ALLIANCELOOT = resources looted from that
  // nation's ALLIANCE. Both show a full resource breakdown when available,
  // and explicitly say so when nothing was looted rather than omitting it.
  if (normType === 'VICTORY') {
    const lootLine = getLootLineForAttack(attack);
    embed.addFields({ name:'🏆 Looted from Nation', value: lootLine || 'Nothing was looted.', inline:false });
  }
  if (normType === 'ALLIANCELOOT') {
    const lootLine = getLootLineForAttack(attack);
    embed.addFields({ name:'💰 Looted from Alliance', value: lootLine || 'Nothing was looted.', inline:false });
  }

  const attLosses=[], defLosses=[];
  if ((attack.att_soldiers_lost||0)>0) attLosses.push(`👮 ${Number(attack.att_soldiers_lost).toLocaleString()} soldiers`);
  if ((attack.att_tanks_lost||0)>0)    attLosses.push(`🚗 ${Number(attack.att_tanks_lost).toLocaleString()} tanks`);
  if ((attack.att_aircraft_lost||0)>0) attLosses.push(`✈️ ${Number(attack.att_aircraft_lost).toLocaleString()} planes`);
  if ((attack.att_ships_lost||0)>0)    attLosses.push(`🚢 ${Number(attack.att_ships_lost).toLocaleString()} ships`);
  if ((attack.def_soldiers_lost||0)>0) defLosses.push(`👮 ${Number(attack.def_soldiers_lost).toLocaleString()} soldiers`);
  if ((attack.def_tanks_lost||0)>0)    defLosses.push(`🚗 ${Number(attack.def_tanks_lost).toLocaleString()} tanks`);
  if ((attack.def_aircraft_lost||0)>0) defLosses.push(`✈️ ${Number(attack.def_aircraft_lost).toLocaleString()} planes`);
  if ((attack.def_ships_lost||0)>0)    defLosses.push(`🚢 ${Number(attack.def_ships_lost).toLocaleString()} ships`);
  if (attLosses.length>0) embed.addFields({ name:`⚔️ ${attName} Lost`, value:attLosses.join('\n'), inline:true });
  if (defLosses.length>0) embed.addFields({ name:`🛡️ ${defName} Lost`, value:defLosses.join('\n'), inline:true });

  const munUsed=(attack.att_mun_used||0)+(attack.def_mun_used||0);
  const gasUsed=(attack.att_gas_used||0)+(attack.def_gas_used||0);
  if (munUsed>0||gasUsed>0) embed.addFields({ name:'⛽ Resources Used', value:`Munitions: ${munUsed.toFixed(1)} | Gasoline: ${gasUsed.toFixed(1)}`, inline:false });

  const gifUrl = getGif(attack.type, successTag);
  if (gifUrl) embed.setImage(gifUrl);

  // TEMP DIAGNOSTIC: missile GIFs were reported as not showing despite the
  // URL and code logic checking out fine in review — logging what actually
  // happens here (rather than guessing again) so the real cause is visible
  // on the next missile attack. Uses logger.info so it isn't filtered out
  // on Railway's production log level. Remove once confirmed/fixed.
  if (normalizeAttackType(attack.type) === 'MISSILE' || normalizeAttackType(attack.type) === 'MISSILEFAIL') {
    logger.info(`MISSILE GIF DEBUG: type=${attack.type} normType=${normalizeAttackType(attack.type)} successTag=${successTag} resolvedGifUrl=${gifUrl || 'NULL'}`);
  }

  if (attack.date) {
    const d = new Date(attack.date);
    if (!isNaN(d.getTime())) embed.setTimestamp(d);
  }

  return embed;
}

async function checkWarRoomAttacks(client) {
  const rooms = query(`SELECT wr.* FROM war_rooms wr WHERE wr.status='active'`, []).rows;
  if (rooms.length === 0) return;

  // Build war_id -> { room, ctx } once, then fetch every active war's
  // attacks in a SINGLE API call (see fetchAttacksBatch) instead of one
  // call per room-member — this is what actually frees up headroom to
  // poll more often within P&W's daily request quota.
  const warMap = new Map(); // war_id -> { room, ctx }
  for (const room of rooms) {
    const members = query('SELECT DISTINCT war_id, nation_id, nation_name FROM war_room_members WHERE war_room_id=?', [room.id]).rows;
    for (const { war_id, nation_id, nation_name } of members) {
      if (!war_id || warMap.has(String(war_id))) continue;
      warMap.set(String(war_id), {
        room,
        ctx: {
          ourNationId:     nation_id,
          ourNationName:   nation_name,
          enemyNationId:   room.enemy_nation_id,
          enemyNationName: room.enemy_nation_name,
        },
      });
    }
  }
  if (warMap.size === 0) return;

  const allAttacks = await fetchAttacksBatch([...warMap.keys()]);
  if (allAttacks.length === 0) return;

  // Group by war_id so each room only processes its own attacks.
  const byWar = new Map();
  for (const attack of allAttacks) {
    const key = String(attack.war_id);
    if (!byWar.has(key)) byWar.set(key, []);
    byWar.get(key).push(attack);
  }

  for (const [warId, warAttacks] of byWar) {
    const entry = warMap.get(warId);
    if (!entry) continue;
    await sendWarAttacks(client, entry.room, warId, entry.ctx, warAttacks);
  }
}

async function sendWarAttacks(client, room, war_id, ctx, attacks) {
  try {
    const channel = client.channels.cache.get(room.channel_id);
    if (!channel) return;

    const lastRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='war_attack_last' AND setting_key=?`, [room.guild_id, String(war_id)]);
    const lastAttackId = lastRow?.setting_value || null;
    const newAttacks = lastAttackId ? attacks.filter(a => parseInt(a.id) > parseInt(lastAttackId)) : attacks;
    if (newAttacks.length === 0) return;
    newAttacks.sort((a,b)=>parseInt(a.id)-parseInt(b.id));

    for (const attack of newAttacks) {
      if (normalizeAttackType(attack.type) === 'PEACE') {
        attack._peaceAction = resolvePeaceAction(room.guild_id, war_id, attack);
      }
      const embed = buildAttackReport(attack, ctx);
      try {
        await channel.send({ embeds: [embed] });
      } catch (sendErr) {
        // Do NOT mark this attack as reported — the send genuinely failed
        // (often a transient Discord network blip). Stop here so this
        // attack (and anything after it) gets retried in order on the
        // next cycle instead of being silently lost.
        logger.error(`Failed to send attack report (attack ${attack.id}, war ${war_id}): ${sendErr.message}`);
        break;
      }
      run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_attack_last',?,?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [room.guild_id, String(war_id), String(attack.id)]);
    }
  } catch (err) { logger.error(`sendWarAttacks: ${err.message}`); }
}

async function getOrCreateWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  try {
    const existing = queryOne('SELECT * FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [guildId, enemyNation.id, 'active']);
    if (existing) {
      // The DB row can outlive the actual Discord channel if someone
      // deletes the channel manually instead of through the bot — the row
      // still says 'active', so this used to silently route to
      // addMemberToWarRoom, which just no-ops when the channel is missing
      // (no error, no new room, nothing visibly wrong). Detect that here
      // and treat the stale room as gone instead.
      const channelStillExists = guild.channels.cache.get(existing.channel_id);
      if (!channelStillExists) {
        logger.warn(`War room for ${enemyNation.nation_name} pointed at a deleted channel (${existing.channel_id}) — marking stale and creating a fresh room.`);
        run('UPDATE war_rooms SET status=? WHERE id=?', ['closed', existing.id]);
        run('DELETE FROM war_room_members WHERE war_room_id=?', [existing.id]);
      } else {
        await addMemberToWarRoom(client, guild, guildId, existing, ourDiscordId, ourMemberName, war, isCounter, counterDetail);
        return existing;
      }
    }
    return await createWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail);
  } catch (err) { logger.error(`War room error: ${err?.message || JSON.stringify(err)}`); }
}

async function createWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  const catRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [guildId]);
  if (!catRow) return null;
  const category = guild.channels.cache.get(catRow.setting_value);
  if (!category) return null;

  const childCount = guild.channels.cache.filter(c => c.parentId === category.id).size;
  if (childCount >= 50) {
    logger.warn(`War room category "${category.name}" is full (50 channels) — skipping room for ${enemyNation.nation_name}. Archive/close old war rooms or use a second category.`);
    return null;
  }

  if (isInactiveNation(enemyNation.last_active)) {
    logger.info(`Skipping war room for ${enemyNation.nation_name} — inactive ${Math.floor(daysSinceActive(enemyNation.last_active))}+ days (likely a raid).`);
    return null;
  }

  const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
  const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`, [guildId]);
  const overwrites = [{ id:guild.roles.everyone.id, deny:[PermissionFlagsBits.ViewChannel] }];
  if (milRole) overwrites.push({ id:milRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });
  if (govRole) overwrites.push({ id:govRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });

  const safeName = (enemyNation.nation_name||'unknown').toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').slice(0,80);

  // Before creating a brand new channel, check whether one already exists
  // in this category matching this enemy's name but isn't tracked in the
  // database — e.g. the bot's database was reset (fresh Railway deploy,
  // migrated to new hosting, etc.) while the actual Discord channels
  // survived untouched. Adopting it avoids creating a confusing duplicate
  // channel right next to the real one.
  const trackedChannelIds = new Set(query('SELECT channel_id FROM war_rooms WHERE guild_id=?', [guildId]).rows.map(r => r.channel_id));
  const expectedName = `⚔️-${safeName}`;
  let channel = guild.channels.cache.find(c => c.parentId === category.id && c.name === expectedName && !trackedChannelIds.has(c.id));
  let adopted = false;

  if (channel) {
    adopted = true;
    logger.info(`Adopting existing untracked channel "${channel.name}" for ${enemyNation.nation_name} — database was reset but the Discord channel survived.`);
    // Bring permissions up to date immediately rather than waiting for the
    // next sync's reconciliation pass.
    if (guild.roles.everyone) await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel:false }).catch(()=>{});
    if (milRole) await channel.permissionOverwrites.create(milRole.discord_role_id, { ViewChannel:true, SendMessages:true }).catch(()=>{});
    if (govRole) await channel.permissionOverwrites.create(govRole.discord_role_id, { ViewChannel:true, SendMessages:true }).catch(()=>{});
  } else {
    channel = await guild.channels.create({ name:expectedName, type:ChannelType.GuildText, parent:category.id, topic:`War vs ${enemyNation.nation_name} | ${enemyNation.alliance?.name||'None'}`, permissionOverwrites:overwrites });
  }

  run(`INSERT INTO war_rooms (guild_id,channel_id,enemy_nation_id,enemy_nation_name,enemy_alliance_name,status) VALUES(?,?,?,?,?,'active')`,
    [guildId, channel.id, enemyNation.id, enemyNation.nation_name, enemyNation.alliance?.name||'None']);

  const roomRow = queryOne('SELECT id FROM war_rooms WHERE guild_id=? AND channel_id=?', [guildId, channel.id]);
  const roomId  = roomRow?.id;

  run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,?)`,
    [roomId, ourDiscordId, war.ourNationId, ourMemberName, war.id]);

  if (ourDiscordId) await channel.permissionOverwrites.create(ourDiscordId, {ViewChannel:true,SendMessages:true}).catch(()=>{});

  const link = ourDiscordId ? `<@${ourDiscordId}>` : `**${ourMemberName}**`;
  await channel.send({ content: adopted
    ? `🔄 Recovered tracking for this room after a database reset. ${link} joined the fray! ⚔️`
    : `${link} joined the fray! ⚔️`
  }).catch(()=>{});
  if (isCounter) await channel.send({ content: `🔄 **COUNTER WAR** — _${counterDetail}_` }).catch(()=>{});

  const roomFull = queryOne('SELECT * FROM war_rooms WHERE id=?', [roomId]);
  await sendUnifiedWarCard(channel, roomFull);

  logger.info(`War room ${adopted ? 'adopted' : 'created'}: ${channel.name} for war ${war.id}`);
  return { id:roomId, channel_id:channel.id, adopted };
}

// Creates a war room AHEAD of any actual declaration, for a target the
// alliance is planning to jump — via /warroom create. Attackers are added
// as "planned" members (war_id left NULL) with full channel access; when
// any of them actually declares, addMemberToWarRoom recognizes their
// nation_id already has a planned row here and activates it in place
// rather than creating a duplicate. Planned rooms are marked room_type
// 'planned' so the inactivity auto-closer leaves them alone while waiting.
async function createPlannedWarRoom(client, guild, guildId, targetNation, plannedAttackers) {
  const catRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [guildId]);
  if (!catRow) return { error: 'No war room category configured. Run `/warroom setup` first.' };
  const category = guild.channels.cache.get(catRow.setting_value);
  if (!category) return { error: 'Configured war room category no longer exists.' };

  const childCount = guild.channels.cache.filter(c => c.parentId === category.id).size;
  if (childCount >= 50) return { error: `War room category "${category.name}" is full (50 channels).` };

  // If a room already exists for this enemy (auto-created or previously
  // planned), add the new planned attackers into it instead of making a
  // duplicate channel.
  const existingRoom = queryOne('SELECT * FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [guildId, targetNation.id, 'active']);

  const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
  const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`, [guildId]);

  let channel, roomId, roomRow;
  if (existingRoom) {
    channel = guild.channels.cache.get(existingRoom.channel_id);
    if (!channel) return { error: 'A room is tracked for this enemy but its channel no longer exists — run `/warroom sync` first to clean that up, then try again.' };
    roomId = existingRoom.id;
    roomRow = existingRoom;
  } else {
    const overwrites = [{ id:guild.roles.everyone.id, deny:[PermissionFlagsBits.ViewChannel] }];
    if (milRole) overwrites.push({ id:milRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });
    if (govRole) overwrites.push({ id:govRole.discord_role_id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] });

    const safeName = (targetNation.nation_name||'unknown').toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').slice(0,80);
    channel = await guild.channels.create({ name:`⚔️-${safeName}`, type:ChannelType.GuildText, parent:category.id, topic:`Planned war vs ${targetNation.nation_name} | ${targetNation.alliance?.name||'None'}`, permissionOverwrites:overwrites });

    run(`INSERT INTO war_rooms (guild_id,channel_id,enemy_nation_id,enemy_nation_name,enemy_alliance_name,status,room_type) VALUES(?,?,?,?,?,'active','planned')`,
      [guildId, channel.id, targetNation.id, targetNation.nation_name, targetNation.alliance?.name||'None']);
    roomRow = queryOne('SELECT * FROM war_rooms WHERE guild_id=? AND channel_id=?', [guildId, channel.id]);
    roomId = roomRow.id;
  }

  const added = [], skipped = [];
  for (const attacker of plannedAttackers) {
    const already = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND nation_id=? AND war_id IS NULL', [roomId, attacker.nationId]);
    if (already) { skipped.push(`${attacker.nationName} (already planned)`); continue; }
    const alreadyAtWar = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND nation_id=? AND war_id IS NOT NULL', [roomId, attacker.nationId]);
    if (alreadyAtWar) { skipped.push(`${attacker.nationName} (already at war here)`); continue; }

    run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,NULL)`,
      [roomId, attacker.discordUserId, attacker.nationId, attacker.nationName]);
    if (attacker.discordUserId) await channel.permissionOverwrites.create(attacker.discordUserId, {ViewChannel:true,SendMessages:true}).catch(()=>{});
    added.push(attacker.nationName);
  }

  const mentionList = plannedAttackers.filter(a=>added.includes(a.nationName) && a.discordUserId).map(a=>`<@${a.discordUserId}>`).join(' ');
  await channel.send({ content: `📋 **War Room Planned** — Target: **${targetNation.nation_name}**\n${mentionList ? mentionList + '\n' : ''}Cards will activate automatically as each attacker declares. This room won't be auto-closed for inactivity — delete it manually when you're done.` });

  await sendUnifiedWarCard(channel, queryOne('SELECT * FROM war_rooms WHERE id=?', [roomId]));

  logger.info(`Planned war room ${existingRoom ? 'updated' : 'created'}: ${channel.name} (+${added.length} planned attackers)`);
  return { id: roomId, channel_id: channel.id, added, skipped, merged: !!existingRoom };
}

// Adds ANOTHER of our members to an already-existing war room against this
// same enemy. Previously this only sent a plain-text line and never gave
// the new member their own war card — the unified card fixes that by
// rebuilding the WHOLE room's card (now including this member) instead.
// Deduped by war_id, not discord_user_id: the same member can legitimately
// start a brand new, separate war against this same enemy later on
// (declare, peace out, redeclare) — deduping by member alone silently
// dropped that new war from tracking entirely, which is why some members'
// attacks were never reported.
async function addMemberToWarRoom(client, guild, guildId, roomRow, ourDiscordId, ourMemberName, war, isCounter, counterDetail) {
  const channel = guild.channels.cache.get(roomRow.channel_id);
  if (!channel) return;
  const already = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND war_id=?', [roomRow.id, war.id]);
  if (already) return;

  // Was this nation already sitting in the room as a PLANNED attacker
  // (added via /warroom create, war_id still NULL) waiting for exactly
  // this declaration? If so, activate that row in place instead of
  // inserting a duplicate — this is what makes "@member joined the fray"
  // + the war card show up correctly for a pre-planned attacker.
  const plannedRow = queryOne('SELECT id FROM war_room_members WHERE war_room_id=? AND war_id IS NULL AND nation_id=?', [roomRow.id, war.ourNationId]);
  if (plannedRow) {
    run('UPDATE war_room_members SET war_id=?, discord_user_id=COALESCE(discord_user_id,?), nation_name=? WHERE id=?', [war.id, ourDiscordId, ourMemberName, plannedRow.id]);
  } else {
    run(`INSERT OR IGNORE INTO war_room_members (war_room_id,discord_user_id,nation_id,nation_name,war_id) VALUES(?,?,?,?,?)`, [roomRow.id,ourDiscordId,war.ourNationId,ourMemberName,war.id]);
  }

  if (ourDiscordId) await channel.permissionOverwrites.create(ourDiscordId, {ViewChannel:true,SendMessages:true}).catch(()=>{});
  await channel.send({ content:`${ourDiscordId?`<@${ourDiscordId}>`:`**${ourMemberName}**`} joined the fray! ⚔️`+(isCounter?`\n🔄 **COUNTER WAR** — _${counterDetail}_`:'') });
  await sendUnifiedWarCard(channel, roomRow);
}

// ── PERMISSION RECONCILIATION ──────────────────────────────────
// Recomputes who SHOULD have access to a war room's channel (the
// configured military/government roles + every currently-tracked
// member's Discord account) and adjusts the actual Discord overwrites
// to match — adding what's missing, removing what's stale. This is what
// makes role changes (e.g. swapping who counts as "military") and
// retroactive linking (a member who wasn't linked at attack time getting
// linked later) actually take effect on existing rooms instead of only
// applying to brand new ones.
async function reconcileRoomPermissions(client, guild, guildId, room) {
  try {
    const channel = guild.channels.cache.get(room.channel_id);
    if (!channel) return { changed: false, reason: 'channel missing' };

    const milRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='military'`, [guildId]);
    const govRole = queryOne(`SELECT discord_role_id FROM guild_roles WHERE guild_id=? AND role_type='government'`, [guildId]);
    const members = query('SELECT discord_user_id FROM war_room_members WHERE war_room_id=? AND discord_user_id IS NOT NULL', [room.id]).rows;

    const desiredIds = new Set();
    if (milRole?.discord_role_id) desiredIds.add(milRole.discord_role_id);
    if (govRole?.discord_role_id) desiredIds.add(govRole.discord_role_id);
    for (const m of members) if (m.discord_user_id) desiredIds.add(String(m.discord_user_id));

    const botId = client.user.id;
    let added = 0, removed = 0;

    // Remove overwrites nobody should have anymore (stale role, un-tracked member) —
    // but never touch @everyone (the deny-all baseline) or the bot itself.
    for (const [id] of channel.permissionOverwrites.cache) {
      if (id === guild.roles.everyone.id || id === botId) continue;
      if (!desiredIds.has(String(id))) {
        await channel.permissionOverwrites.delete(id).catch(()=>{});
        removed++;
      }
    }

    // Add whatever's missing
    for (const id of desiredIds) {
      const existingOverwrite = channel.permissionOverwrites.cache.get(id);
      if (!existingOverwrite || !existingOverwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
        await channel.permissionOverwrites.create(id, { ViewChannel:true, SendMessages:true }).catch(()=>{});
        added++;
      }
    }

    return { changed: added>0 || removed>0, added, removed };
  } catch (err) {
    logger.error(`reconcileRoomPermissions: ${err.message}`);
    return { changed:false, error:err.message };
  }
}

// ── SHARED SYNC ENGINE ──────────────────────────────────────────
// The actual logic behind /warroom sync — factored out here so it can be
// called both from the slash command AND from the scheduled auto-sync job
// without duplicating it. Handles: creating rooms for new wars, adding
// additional members to existing rooms, retroactively linking a member's
// Discord account if they weren't linked at the time of their attack (and
// fixing their channel access once they are), and reconciling every active
// room's permissions against current role configuration.
// Targeted recovery for ONE specific channel — used by /warroom card when
// the channel isn't tracked. Guesses the enemy nation from the channel
// name, checks whether they currently have an active war against our
// alliance, and if so routes through the normal getOrCreateWarRoom path
// (which will detect any stale DB row pointing at a deleted duplicate and
// adopt THIS channel by name-match) — without needing to wait for or run
// a full alliance-wide /warroom sync.
async function recoverWarRoomChannel(client, guild, guildId, channel, allianceId) {
  const guessedName = channel.name.replace(/^⚔️-/, '').replace(/-/g, ' ').trim();
  if (!guessedName) return { error: 'Could not guess an enemy name from this channel\'s name.' };

  const candidate = await searchNationByName(guessedName);
  if (!candidate) return { error: `Could not find any nation matching "${guessedName}" from this channel's name.` };

  const wars = await getNationWars(candidate.id);
  const allianceIdStr = String(allianceId);
  const relevantWars = wars.filter(w => String(w.att_alliance_id) === allianceIdStr || String(w.def_alliance_id) === allianceIdStr);
  if (relevantWars.length === 0) {
    return { error: `Found nation **${candidate.nation_name}**, but they have no active war against our alliance right now — nothing to recover.` };
  }

  const enemyNation = await getNation(candidate.id);
  if (!enemyNation) return { error: 'Could not fetch full nation data for the matched enemy.' };

  const discordMap = buildNationToDiscordMap(guildId);
  let recovered = 0;
  for (const war of relevantWars) {
    const isOff = String(war.att_alliance_id) === allianceIdStr;
    const ourNationId = isOff ? war.attid : war.defid;
    const ourNationName = isOff ? war.attacker?.nation_name : war.defender?.nation_name;
    const ourDiscordId = discordMap.get(ourNationId) || discordMap.get(String(ourNationId)) || null;

    const enrichedWar = { id: war.id, isOurAttack: isOff, ourNationId, turnsleft: war.turnsleft };
    const result = await getOrCreateWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourNationName, enrichedWar, false, null);
    if (result) recovered++;
  }

  return { recovered, enemyName: enemyNation.nation_name, warsFound: relevantWars.length };
}

async function runWarRoomSync(client, guild, guildId, allianceId, { includeOffensive = true } = {}) {
  const summary = { created:0, adopted:0, addedToExisting:0, existing:0, relinked:0, inactive:0, skipped:0, permissionsFixed:0, errors:[], defWarsCount:0, offWarsCount:0 };
  const allianceIdStr = String(allianceId);

  let allWars = [];
  try {
    const data = await pwQuery(`
      query GetAllianceWars($allianceId:[Int]) {
        wars(alliance_id:$allianceId, active:true, first:100) {
          data {
            id att_alliance_id def_alliance_id attid defid
            att_resistance def_resistance turnsleft
            attacker { id nation_name score alliance_position soldiers tanks aircraft ships missiles nukes spies last_active alliance { id name } }
            defender { id nation_name score alliance_position soldiers tanks aircraft ships missiles nukes spies last_active alliance { id name } }
          }
        }
      }
    `, { allianceId: [parseInt(allianceId)] });
    allWars = data?.wars?.data || [];
  } catch (err) {
    summary.errors.push(`Failed to fetch wars: ${err.message}`);
    return summary;
  }

  const defWars = allWars.filter(w => String(w.def_alliance_id) === allianceIdStr);
  const offWars = includeOffensive ? allWars.filter(w => String(w.att_alliance_id) === allianceIdStr) : [];
  const warsToProcess = [...defWars, ...offWars];
  summary.defWarsCount = defWars.length;
  summary.offWarsCount = offWars.length;

  const discordMap = buildNationToDiscordMap(guildId);

  for (const war of warsToProcess) {
    try {
      const isOff       = String(war.att_alliance_id) === allianceIdStr;
      const ourNation   = isOff ? war.attacker : war.defender;
      const enemyNation = isOff ? war.defender : war.attacker;

      if (!ourNation || !enemyNation) { summary.skipped++; continue; }
      if (!MEMBER_POSITIONS.includes((ourNation.alliance_position || '').toUpperCase())) { summary.skipped++; continue; }

      const ourDiscordId = discordMap.get(ourNation.id) || discordMap.get(String(ourNation.id)) || null;

      const existingRoom = queryOne('SELECT id FROM war_rooms WHERE guild_id=? AND enemy_nation_id=? AND status=?', [guildId, enemyNation.id, 'active']);
      const existingMemberRow = existingRoom && queryOne('SELECT * FROM war_room_members WHERE war_room_id=? AND war_id=?', [existingRoom.id, war.id]);

      if (existingMemberRow) {
        // Already tracked. If they weren't linked to Discord at the time
        // (so had no channel access, no mention) but ARE linked now, fix
        // that retroactively instead of leaving them stuck forever.
        if (!existingMemberRow.discord_user_id && ourDiscordId) {
          run('UPDATE war_room_members SET discord_user_id=?, nation_name=? WHERE id=?', [ourDiscordId, ourNation.nation_name, existingMemberRow.id]);
          summary.relinked++;
        } else {
          summary.existing++;
          continue;
        }
      } else {
        if (isInactiveNation(enemyNation.last_active)) { summary.inactive++; continue; }

        const counterResult = await isLegitimateCounter(guildId, allianceId, enemyNation.id, enemyNation.alliance?.id);
        if (isOff && !counterResult.isCounter) {
          const dnrEntry = queryOne('SELECT id FROM dnr_list WHERE guild_id=? AND alliance_id=?', [guildId, parseInt(enemyNation.alliance?.id || 0)]);
          if (dnrEntry) { summary.skipped++; continue; }
        }

        run(`INSERT OR IGNORE INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'war_seen',?,datetime('now'))`,
          [guildId, `war_${guildId}_${war.id}_${isOff ? 'off' : 'def'}`]);

        const enrichedWar = {
          id: war.id, isOurAttack: isOff, ourNationId: ourNation.id, turnsleft: war.turnsleft,
          ourResistance: isOff ? war.att_resistance : war.def_resistance,
          enemyResistance: isOff ? war.def_resistance : war.att_resistance,
        };

        const result = await getOrCreateWarRoom(client, guild, guildId, enemyNation, ourDiscordId, ourNation.nation_name, enrichedWar, counterResult.isCounter, counterResult.detail);
        if (result && existingRoom) summary.addedToExisting++;
        else if (result && result.adopted) summary.adopted++;
        else if (result) summary.created++;
        else summary.skipped++;

        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      summary.errors.push(`War ${war.id}: ${err.message}`);
      summary.skipped++;
    }
  }

  // Reconcile permissions across EVERY active room in this guild — not just
  // ones tied to a war matched this cycle — so role config changes and
  // retroactive links propagate everywhere they should.
  const allActiveRooms = query('SELECT * FROM war_rooms WHERE guild_id=? AND status=?', [guildId, 'active']).rows;
  for (const room of allActiveRooms) {
    const result = await reconcileRoomPermissions(client, guild, guildId, room);
    if (result.changed) summary.permissionsFixed++;
  }

  return summary;
}

async function removeMemberFromWarRoom(client, guild, guildId, nationId, warId) {
  try {
    const member = queryOne(`SELECT wrm.*,wr.channel_id,wr.id as room_id FROM war_room_members wrm JOIN war_rooms wr ON wr.id=wrm.war_room_id WHERE wr.guild_id=? AND wrm.nation_id=? AND wrm.war_id=?`, [guildId,nationId,warId]);
    if (!member) return;
    run('DELETE FROM war_room_members WHERE id=?', [member.id]);
    const channel = guild.channels.cache.get(member.channel_id);
    if (channel) {
      if (member.discord_user_id) await channel.permissionOverwrites.delete(member.discord_user_id).catch(()=>{});
      await channel.send({ content:`✅ <@${member.discord_user_id}>'s war ended — removed from this room.` });
    }
    const remaining = query('SELECT * FROM war_room_members WHERE war_room_id=?', [member.room_id]).rows;
    if (remaining.length===0) {
      if (channel) { await channel.send({content:'🏁 All wars concluded — deleting in 10 seconds.'}); setTimeout(async()=>{ await channel.delete().catch(()=>{}); },10000); }
      run('UPDATE war_rooms SET status=? WHERE id=?', ['closed',member.room_id]);
    }
  } catch (err) { logger.error(`removeMemberFromWarRoom: ${err.message}`); }
}

module.exports = { getOrCreateWarRoom, removeMemberFromWarRoom, buildWarButtons, fetchWarData, fetchNationData, sendUnifiedWarCard, checkWarRoomAttacks, isInactiveNation, daysSinceActive, closeWarRoomForInactivity, INACTIVITY_DAYS, runWarRoomSync, reconcileRoomPermissions, createPlannedWarRoom, recoverWarRoomChannel };
