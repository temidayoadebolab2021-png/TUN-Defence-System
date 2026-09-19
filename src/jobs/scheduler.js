// ============================================================
// src/jobs/scheduler.js — attack reports every 2 minutes
// ============================================================

const cron = require('node-cron');
const logger = require('../utils/logger');
const { checkBeigeExits } = require('./beigeJob');
const { generateDailyReport } = require('./reportJob');
const { checkMilitaryChanges } = require('../systems/intelligence/militaryMonitor');
const { checkAllianceDefense } = require('../systems/defense/warMonitor');
const { checkVacationChanges, checkWarExpiry } = require('../systems/intelligence/vacationTracker');
const { checkDnrViolations } = require('../systems/intelligence/dnrMonitor');
const { runAutoBackup } = require('./backupJob');
const { checkWarRoomAttacks, runWarRoomSync } = require('../systems/military/warRoomManager');
const { query, queryOne } = require('../utils/database');

async function startAllJobs(client) {
  logger.info('Starting background job scheduler...');

  setTimeout(async () => {
    logger.info('Running startup checks...');
    await checkBeigeExits(client);
    await checkAllianceDefense(client);
    await checkDnrViolations(client);
  }, 10000);

  // Defense check every 60 seconds
  cron.schedule('* * * * *', async () => {
    await checkAllianceDefense(client);
  });

  // War room attack reports every 8 seconds. Safe under a 15k/day VIP quota
  // now that checkWarRoomAttacks does ONE batched API call per cycle
  // regardless of how many war rooms are active (see warRoomManager.js).
  // 8s ≈ 10,800 requests/day for this job alone, leaving headroom for the
  // other scheduled jobs below plus manual commands and retries.
  cron.schedule('*/8 * * * * *', async () => {
    await checkWarRoomAttacks(client);
  });

  // DNR check every 3 minutes
  cron.schedule('*/3 * * * *', async () => {
    logger.debug('🚫 Checking DNR violations...');
    await checkDnrViolations(client);
  });

  // Beige check every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    logger.debug('⏰ Running beige check...');
    await checkBeigeExits(client);
  });

  // Military changes every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    logger.debug('🔍 Checking military changes...');
    await checkMilitaryChanges(client);
  });

  // Vacation mode every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    logger.debug('🏖️ Checking vacation mode changes...');
    await checkVacationChanges(client);
  });

  // War expiry every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.debug('⏰ Checking war expiry...');
    await checkWarExpiry(client);
  });

  // Auto backup every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    logger.info('💾 Running auto backup...');
    await runAutoBackup(client);
  });

  // Daily report at 08:00 UTC
  cron.schedule('0 8 * * *', async () => {
    logger.info('📅 Sending daily reports...');
    await generateDailyReport(client);
  });

  // Auto-sync every 15 minutes: creates rooms for wars that slipped through,
  // adds additional members fighting the same enemy, retroactively links
  // members who weren't linked to Discord at attack time, and reconciles
  // every active room's permissions against current role config. Runs for
  // every guild that has BOTH a war room category configured AND hasn't
  // explicitly turned it off via `/warroom autosync false` (default: ON).
  let autoSyncRunning = false;
  cron.schedule('*/15 * * * *', async () => {
    if (autoSyncRunning) { logger.debug('Auto-sync still running from last cycle — skipping this one.'); return; }
    autoSyncRunning = true;
    try {
      await runWarRoomAutoSync(client);
    } finally {
      autoSyncRunning = false;
    }
  });

  logger.info('✅ Scheduler — defense 60s | attacks adaptive 8s-96s | DNR 3min | beige 5min | military/vacation 15min | expiry 30min | warroom autosync 15min | backup 6h | daily 08:00 UTC');
}

async function runWarRoomAutoSync(client) {
  const guildRows = query('SELECT guild_id, alliance_id FROM guilds WHERE alliance_id IS NOT NULL', []).rows;
  for (const g of guildRows) {
    try {
      const catRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='category_id'`, [g.guild_id]);
      if (!catRow) continue; // war rooms not set up for this guild yet

      const autosyncRow = queryOne(`SELECT setting_value FROM alert_settings WHERE guild_id=? AND alert_type='warroom' AND setting_key='autosync'`, [g.guild_id]);
      const enabled = autosyncRow ? autosyncRow.setting_value === 'true' : true; // default ON unless explicitly turned off
      if (!enabled) continue;

      const guild = client.guilds.cache.get(g.guild_id);
      if (!guild) continue;

      const summary = await runWarRoomSync(client, guild, g.guild_id, g.alliance_id, { includeOffensive: true });
      const somethingHappened = summary.created + summary.addedToExisting + summary.relinked + summary.permissionsFixed > 0;
      if (somethingHappened) {
        logger.info(`Auto-sync (guild ${g.guild_id}): +${summary.created} new rooms, +${summary.addedToExisting} added as member, ${summary.relinked} retroactively linked, ${summary.permissionsFixed} room(s) had permission fixes`);
      }
      if (summary.errors.length > 0) {
        logger.warn(`Auto-sync (guild ${g.guild_id}) had ${summary.errors.length} error(s): ${summary.errors.slice(0,3).join(' | ')}`);
      }
    } catch (err) {
      logger.error(`Auto-sync error for guild ${g.guild_id}: ${err.message}`);
    }
  }
}

module.exports = { startAllJobs };
