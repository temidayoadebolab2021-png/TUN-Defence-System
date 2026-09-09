// ============================================================
// src/commands/military/warroom.js — fixed: no att_map/def_map
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { run, queryOne, query } = require('../../utils/database');
const { isInactiveNation, sendUnifiedWarCard, runWarRoomSync, createPlannedWarRoom, recoverWarRoomChannel } = require('../../systems/military/warRoomManager');
const { resolveNation, getAllianceMembers } = require('../../utils/pwApi');
const { getLinkedNation, buildNationToDiscordMap } = require('../../utils/nationLink');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warroom')
    .setDescription('Configure and manage war rooms')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Set the category where war rooms will be created')
        .addChannelOption(opt => opt.setName('category').setDescription('Discord category for war rooms').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('status').setDescription('Show current war room config and active rooms'))
    .addSubcommand(sub =>
      sub.setName('sync')
        .setDescription('Force-create war rooms for ALL currently active wars (including old ones)')
        .addBooleanOption(opt => opt.setName('offensive').setDescription('Also create rooms for offensive wars (default: true)'))
    )
    .addSubcommand(sub =>
      sub.setName('card')
        .setDescription('Regenerate this war room\'s card — use if it was accidentally deleted')
    )
    .addSubcommand(sub =>
      sub.setName('autosync')
        .setDescription('Turn the automatic background sync on or off')
        .addBooleanOption(opt => opt.setName('enabled').setDescription('On or off').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Set up a war room ahead of time for a planned target, before anyone declares')
        .addStringOption(opt => opt.setName('target').setDescription('Enemy nation name, profile link, or ID').setRequired(true))
        .addStringOption(opt => opt.setName('attackers').setDescription('Comma-separated: @mentions, Discord names, or nation names').setRequired(true))
    ),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── SETUP ─────────────────────────────────────────────────
    if (sub === 'setup') {
      if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ content: '❌ Only Administrators can configure the war room category.', flags: 64 });
      }
      const category = interaction.options.getChannel('category');
      if (category.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '❌ Please select a **Category**, not a text channel.', flags: 64 });
      }
      run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'warroom','category_id',?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [interaction.guildId, category.id]);
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✅ War Room Category Set').setColor(0x2ecc71)
          .setDescription(`War rooms will be created in **${category.name}**.\n\n**Bot needs:**\n• Manage Channels\n• Manage Permissions\n• View Channel\n• Send Messages\n\nRun \`/warroom sync\` to create rooms for all active wars now.`).setTimestamp()],
        flags: 64,
      });
    }

    // ── STATUS ────────────────────────────────────────────────
    if (sub === 'status') {
      const catRow      = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [interaction.guildId]);
      const activeRooms = query(`SELECT * FROM war_rooms WHERE guild_id=? AND status='active' ORDER BY created_at DESC`, [interaction.guildId]).rows;
      const category    = catRow ? interaction.guild.channels.cache.get(catRow.setting_value) : null;

      const roomLines = activeRooms.slice(0, 10).map(r => {
        const ch = interaction.guild.channels.cache.get(r.channel_id);
        const mc = query('SELECT COUNT(*) as c FROM war_room_members WHERE war_room_id=?', [r.id]).rows[0]?.c || 0;
        return `• ${ch ? ch.toString() : '#deleted'} — vs **${r.enemy_nation_name}** (${r.enemy_alliance_name}) | ${mc} member(s)`;
      });

      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('⚙️ War Room Configuration').setColor(0x3498db)
          .addFields(
            { name: '📁 Category', value: category ? `**${category.name}**` : catRow ? '❌ Not found — reconfigure' : '❌ Not configured — run `/warroom setup`' },
            { name: `⚔️ Active War Rooms (${activeRooms.length})`, value: roomLines.length > 0 ? roomLines.join('\n') + (activeRooms.length > 10 ? `\n_+${activeRooms.length - 10} more_` : '') : '_None_' },
          ).setFooter({ text: 'Use /warroom sync to create rooms for missing active wars' }).setTimestamp()],
        flags: 64,
      });
    }

    // ── SYNC ──────────────────────────────────────────────────
    // ── CARD — regenerate a lost/deleted war card ────────────
    if (sub === 'card') {
      await interaction.deferReply({ flags: 64 });

      let room = queryOne(`SELECT * FROM war_rooms WHERE guild_id=? AND channel_id=? AND status='active'`, [interaction.guildId, interaction.channelId]);

      if (!room) {
        // Not tracked — try to recover it directly rather than just saying
        // "not a war room". This covers the case where the database was
        // reset (new hosting, etc.) and a duplicate channel got created and
        // was manually deleted afterward, leaving the original channel
        // untracked even though it's clearly still a real war room.
        const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
        if (!guildRow?.alliance_id) {
          return interaction.editReply('❌ This channel isn\'t an active war room, and no alliance is configured to try recovering it.');
        }

        await interaction.editReply('🔍 Not tracked yet — checking if this channel matches an active war...');
        const recovery = await recoverWarRoomChannel(interaction.client, interaction.guild, interaction.guildId, interaction.channel, guildRow.alliance_id);
        if (recovery.error) {
          return interaction.editReply(`❌ ${recovery.error}`);
        }

        room = queryOne(`SELECT * FROM war_rooms WHERE guild_id=? AND channel_id=? AND status='active'`, [interaction.guildId, interaction.channelId]);
        if (!room) {
          return interaction.editReply(`⚠️ Found **${recovery.enemyName}** with an active war, but couldn't attach it to this exact channel — it may have created a separate room instead. Check the category for a duplicate.`);
        }
        // Room was just recovered and its card already sent by the recovery
        // path itself — no need to build a second one below.
        return interaction.editReply(`✅ Recovered tracking for this room (matched **${recovery.enemyName}**, ${recovery.warsFound} active war(s)) — card posted above.`);
      }

      const memberCount = query('SELECT COUNT(*) as c FROM war_room_members WHERE war_room_id=?', [room.id]).rows[0]?.c || 0;
      if (memberCount === 0) {
        return interaction.editReply('❌ This war room has no tracked members to build a card from — nothing to regenerate.');
      }

      const newCard = await sendUnifiedWarCard(interaction.channel, room);
      if (!newCard) {
        return interaction.editReply('❌ Something went wrong building the card. Check the bot logs for details.');
      }

      return interaction.editReply(`✅ War card regenerated for **${memberCount} member${memberCount===1?'':'s'}** — check the bottom of the channel (it's pinned).`);
    }

    if (sub === 'sync') {
      await interaction.deferReply({ flags: 64 });

      const catRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [interaction.guildId]);
      if (!catRow) return interaction.editReply('❌ No war room category configured. Run `/warroom setup` first.');

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
      if (!guildRow?.alliance_id) return interaction.editReply('❌ No alliance configured.');

      const includeOff = interaction.options.getBoolean('offensive') ?? true;
      await interaction.editReply('⏳ Syncing wars, members, and permissions...');

      const summary = await runWarRoomSync(interaction.client, interaction.guild, interaction.guildId, guildRow.alliance_id, { includeOffensive: includeOff });

      const embed = new EmbedBuilder()
        .setTitle('✅ War Room Sync Complete')
        .setColor((summary.created + summary.adopted + summary.addedToExisting + summary.relinked) > 0 ? 0x2ecc71 : 0x95a5a6)
        .addFields(
          { name: '🆕 New Rooms',        value: `${summary.created}`,  inline: true },
          { name: '🔄 Adopted (recovered)', value: `${summary.adopted}`, inline: true },
          { name: '➕ Added as Member',  value: `${summary.addedToExisting}`, inline: true },
          { name: '🔗 Retroactively Linked', value: `${summary.relinked}`, inline: true },
          { name: '✅ Already Tracked',  value: `${summary.existing}`, inline: true },
          { name: '💤 Skipped (inactive 5d+)', value: `${summary.inactive}`, inline: true },
          { name: '⏭️ Skipped (other)',   value: `${summary.skipped}`,  inline: true },
          { name: '🔧 Rooms w/ Permission Fixes', value: `${summary.permissionsFixed}`, inline: true },
          { name: '📊 Wars Scanned',     value: `${summary.defWarsCount} def + ${summary.offWarsCount} off = **${summary.defWarsCount + summary.offWarsCount}**`, inline: false },
        ).setTimestamp();
      if (summary.errors.length > 0) embed.addFields({ name: '⚠️ Errors', value: summary.errors.slice(0, 5).join('\n').slice(0, 1020) });

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── AUTOSYNC — toggle the scheduled background sync ──────
    if (sub === 'autosync') {
      const enabled = interaction.options.getBoolean('enabled');
      run(`INSERT INTO alert_settings (guild_id,alert_type,setting_key,setting_value) VALUES(?,'warroom','autosync',?) ON CONFLICT(guild_id,alert_type,setting_key) DO UPDATE SET setting_value=excluded.setting_value`,
        [interaction.guildId, enabled ? 'true' : 'false']);
      return interaction.reply({
        content: enabled
          ? '✅ Auto-sync is now **ON** — war rooms, members, and permissions will be synced automatically in the background.'
          : '✅ Auto-sync is now **OFF** — you\'ll need to run `/warroom sync` manually.',
        flags: 64,
      });
    }

    // ── CREATE — set up a room ahead of time for a planned target ─
    if (sub === 'create') {
      await interaction.deferReply({ flags: 64 });

      const targetInput = interaction.options.getString('target');
      const attackersInput = interaction.options.getString('attackers');

      const targetNation = await resolveNation(targetInput);
      if (!targetNation) return interaction.editReply(`❌ Could not find a nation matching "${targetInput}".`);

      const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id=?', [interaction.guildId]);
      const allianceMembers = guildRow?.alliance_id ? await getAllianceMembers(guildRow.alliance_id) : [];

      const tokens = attackersInput.split(',').map(t => t.trim()).filter(Boolean);
      if (tokens.length === 0) return interaction.editReply('❌ No attackers provided.');

      const resolved = [], unresolved = [];
      for (const token of tokens) {
        const result = resolveAttackerToken(token, interaction.guild, interaction.guildId, allianceMembers);
        if (result.error) unresolved.push(`**${token}**: ${result.error}`);
        else resolved.push(result);
      }

      if (resolved.length === 0) {
        return interaction.editReply(`❌ Could not resolve any attackers.\n${unresolved.join('\n')}`);
      }

      const result = await createPlannedWarRoom(interaction.client, interaction.guild, interaction.guildId, targetNation, resolved);
      if (result.error) return interaction.editReply(`❌ ${result.error}`);

      const embed = new EmbedBuilder()
        .setTitle(result.merged ? '📋 Added to Existing War Room' : '📋 War Room Planned')
        .setColor(0x3498db)
        .setDescription(`Target: **${targetNation.nation_name}**\nRoom: <#${result.channel_id}>`)
        .addFields({ name: '✅ Added', value: result.added.length ? result.added.join('\n') : 'None', inline: true });
      if (result.skipped.length > 0) embed.addFields({ name: '⏭️ Skipped', value: result.skipped.join('\n'), inline: true });
      if (unresolved.length > 0) embed.addFields({ name: '⚠️ Unresolved', value: unresolved.join('\n').slice(0, 1020), inline: false });

      return interaction.editReply({ embeds: [embed] });
    }
  },
};

// Resolves one comma-separated "attackers" token to a Discord user + P&W
// nation. Accepts a @mention, a plain Discord username/display name, or a
// P&W nation name (matched against the alliance's own roster). A nation_id
// is required to track the planned attacker (it's what later links their
// real declaration back to this row), so an unlinked Discord mention with
// no nation is reported as an error rather than silently added broken.
function resolveAttackerToken(token, guild, guildId, allianceMembers) {
  token = token.trim();
  if (!token) return { error: 'empty' };

  const mentionMatch = token.match(/^<@!?(\d+)>$/);
  let discordUserId = mentionMatch ? mentionMatch[1] : null;

  if (!discordUserId) {
    const lower = token.toLowerCase();
    const member = guild.members.cache.find(m =>
      m.user.username.toLowerCase() === lower || (m.nickname && m.nickname.toLowerCase() === lower) || m.displayName.toLowerCase() === lower
    );
    if (member) discordUserId = member.id;
  }

  if (discordUserId) {
    const link = getLinkedNation(guildId, discordUserId);
    if (link) {
      return { discordUserId, nationId: link.nation_id, nationName: link.nation_name || `Nation #${link.nation_id}` };
    }
    return { error: `<@${discordUserId}> is not linked to a nation — use \`/link\` first` };
  }

  const lowerToken = token.toLowerCase();
  let match = allianceMembers.find(m => m.nation_name.toLowerCase() === lowerToken);
  if (!match) match = allianceMembers.find(m => m.nation_name.toLowerCase().includes(lowerToken));
  if (match) {
    const map = buildNationToDiscordMap(guildId);
    const dId = map.get(match.id) || map.get(String(match.id)) || null;
    return { discordUserId: dId, nationId: match.id, nationName: match.nation_name };
  }

  return { error: 'could not match to a Discord member or alliance nation' };
}
