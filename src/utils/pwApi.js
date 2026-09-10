// ============================================================
// src/utils/pwApi.js — Politics & War API client
// ============================================================

const axios = require('axios');
const logger = require('./logger');

const PW_API_BASE = 'https://api.politicsandwar.com/graphql?api_key=';
const cache = new Map();
const CACHE_TIMES = {
  nation:   5  * 60 * 1000,
  alliance: 10 * 60 * 1000,
};

const MEMBER_POSITIONS = ['MEMBER', 'OFFICER', 'HEIR', 'LEADER'];

// Transient network/TLS errors — usually caused by antivirus HTTPS scanning,
// flaky WiFi, or ISP hiccups corrupting the connection mid-handshake. These
// are NOT API errors; a short retry very often succeeds because the next
// attempt gets a fresh connection.
const TRANSIENT_ERROR_PATTERNS = [
  'ECONNRESET', 'EPROTO', 'ETIMEDOUT', 'ECONNABORTED', 'socket hang up',
  'bad record mac', 'decrypt error', 'ssl3_read_bytes', 'EAI_AGAIN',
];
function isTransientNetworkError(err) {
  const msg = err?.message || '';
  return TRANSIENT_ERROR_PATTERNS.some(p => msg.includes(p));
}

// ─────────────────────────────────────────────────────────────
// CORE QUERY RUNNER — logs full error details
// ─────────────────────────────────────────────────────────────
async function pwQuery(queryStr, variables = {}, _retryCount = 0) {
  const url = `${PW_API_BASE}${process.env.PW_API_KEY}`;
  try {
    const res = await axios.post(url, { query: queryStr, variables }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    // Log the FULL error message so we can see what's wrong
    if (res.data.errors) {
      logger.warn('P&W API errors: ' + JSON.stringify(res.data.errors, null, 2));
    }

    // P&W's daily quota (2,000/day standard, 5,000/day VIP) is a DAILY cap,
    // not per-minute. Hitting it doesn't always throw an HTTP error — it can
    // come back as a normal 200 response with an unexpected body shape,
    // which would otherwise silently look identical to "no data yet". Flag
    // this loudly instead of letting it disappear.
    const bodyText = JSON.stringify(res.data).toLowerCase();
    if (bodyText.includes('limit') && (bodyText.includes('daily') || bodyText.includes('request'))) {
      logger.error('P&W API possibly returned a rate-limit/quota message: ' + JSON.stringify(res.data));
    }
    if (res.data.data === undefined) {
      logger.warn('P&W API response had no `data` field — raw body: ' + JSON.stringify(res.data).slice(0, 500));
    }

    return res.data.data;
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('Rate limited — waiting 60s');
      await new Promise(r => setTimeout(r, 60000));
      return pwQuery(queryStr, variables, _retryCount);
    }
    if (isTransientNetworkError(err) && _retryCount < 2) {
      const delay = 1500 * (_retryCount + 1);
      logger.warn(`P&W API transient network error (${err.message}) — retrying in ${delay}ms (attempt ${_retryCount + 1}/2)`);
      await new Promise(r => setTimeout(r, delay));
      return pwQuery(queryStr, variables, _retryCount + 1);
    }
    logger.error('P&W API HTTP error: ' + err.message);
    if (err.response?.data) {
      logger.error('Response body: ' + JSON.stringify(err.response.data));
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// SMART RESOLVERS
// ─────────────────────────────────────────────────────────────
async function resolveNation(input) {
  if (!input) return null;
  input = input.trim();
  const urlMatch = input.match(/nation\/id=(\d+)/i);
  if (urlMatch) return getNation(parseInt(urlMatch[1]));
  if (/^\d+$/.test(input)) return getNation(parseInt(input));
  return searchNationByName(input);
}

async function resolveAlliance(input) {
  if (!input) return null;
  input = input.trim();
  const urlMatch = input.match(/alliance\/id=(\d+)/i);
  if (urlMatch) return getAllianceInfo(parseInt(urlMatch[1]));
  if (/^\d+$/.test(input)) return getAllianceInfo(parseInt(input));
  return searchAllianceByName(input);
}

// ─────────────────────────────────────────────────────────────
// NATION — fetch by ID
// ─────────────────────────────────────────────────────────────
async function getNation(nationId) {
  const key = `nation_${nationId}`;
  const hit = getFromCache(key);
  if (hit) return hit;

  const data = await pwQuery(`
    query GetNation($id: [Int]) {
      nations(id: $id, first: 1) {
        data {
          id
          nation_name
          leader_name
          alliance_id
          alliance_position
          score
          num_cities
          color
          beige_turns
          vacation_mode_turns
          soldiers
          tanks
          aircraft
          ships
          missiles
          nukes
          offensive_wars_count
          defensive_wars_count
          last_active
          alliance { name }
        }
      }
    }
  `, { id: [nationId] });

  const nation = data?.nations?.data?.[0] || null;
  if (nation) setCache(key, nation, CACHE_TIMES.nation);
  return nation;
}

// ─────────────────────────────────────────────────────────────
// NATION — search by name
// Sends multiple casing variants in one call since the API
// does exact-match only. We pick the right result client-side.
// ─────────────────────────────────────────────────────────────
async function searchNationByName(name) {
  const key = `nation_name_${name.toLowerCase()}`;
  const hit = getFromCache(key);
  if (hit) return hit;

  const variants = dedupe([
    name,
    name.toLowerCase(),
    name.toUpperCase(),
    toTitleCase(name),
    toSentenceCase(name),
  ]);

  logger.debug(`Searching nation by name variants: ${variants.join(', ')}`);

  const data = await pwQuery(`
    query SearchNation($names: [String]) {
      nations(nation_name: $names, first: 10) {
        data {
          id
          nation_name
          leader_name
          alliance_id
          alliance_position
          score
          num_cities
          color
          beige_turns
          vacation_mode_turns
          soldiers
          tanks
          aircraft
          ships
          missiles
          nukes
          offensive_wars_count
          defensive_wars_count
          last_active
          alliance { name }
        }
      }
    }
  `, { names: variants });

  const results = data?.nations?.data || [];
  logger.debug(`Nation name search returned ${results.length} results`);

  if (results.length === 0) return null;

  const target = name.toLowerCase();
  const nation = results.find(n => n.nation_name.toLowerCase() === target) || results[0];

  setCache(key, nation, CACHE_TIMES.nation);
  return nation;
}

// ─────────────────────────────────────────────────────────────
// ALLIANCE — fetch by ID
// ─────────────────────────────────────────────────────────────
async function getAllianceInfo(allianceId) {
  const key = `alliance_${allianceId}`;
  const hit = getFromCache(key);
  if (hit) return hit;

  const data = await pwQuery(`
    query GetAlliance($id: [Int]) {
      alliances(id: $id, first: 1) {
        data {
          id
          name
          score
          color

        }
      }
    }
  `, { id: [parseInt(allianceId)] });

  const alliance = data?.alliances?.data?.[0] || null;
  if (alliance) setCache(key, alliance, CACHE_TIMES.alliance);
  return alliance;
}

// ─────────────────────────────────────────────────────────────
// ALLIANCE — search by name, fully client-side
//
// The P&W alliances() query has NO name filter in the schema.
// We must page through alliances and match locally.
// We fetch up to 4 pages of 50 = 200 alliances.
// ─────────────────────────────────────────────────────────────
async function searchAllianceByName(name) {
  const key = `alliance_name_${name.toLowerCase()}`;
  const hit = getFromCache(key);
  if (hit) return hit;

  const target = name.toLowerCase().trim();
  logger.debug(`Searching alliances client-side for: "${target}"`);

  let found = null;
  let page = 1;

  while (page <= 4 && !found) {
    logger.debug(`Fetching alliance page ${page}...`);

    const data = await pwQuery(`
      query GetAlliancePage($page: Int) {
        alliances(first: 50, page: $page) {
          data {
            id
            name
            score
            color
  
          }
          paginatorInfo {
            hasMorePages
            currentPage
            total
          }
        }
      }
    `, { page });

    const alliances  = data?.alliances?.data || [];
    const hasMore    = data?.alliances?.paginatorInfo?.hasMorePages;
    const total      = data?.alliances?.paginatorInfo?.total;

    logger.debug(`Page ${page}: got ${alliances.length} alliances (total in DB: ${total}, hasMore: ${hasMore})`);

    // Log first few names on page 1 so we can confirm data is coming through
    if (page === 1) {
      logger.debug('First 5 alliance names: ' + alliances.slice(0, 5).map(a => a.name).join(', '));
    }

    // Exact match (case-insensitive)
    found = alliances.find(a => a.name.toLowerCase() === target);
    if (found) { logger.debug(`Exact match found: ${found.name}`); break; }

    // Starts-with match
    found = alliances.find(a => a.name.toLowerCase().startsWith(target));
    if (found) { logger.debug(`Starts-with match found: ${found.name}`); break; }

    // Contains match
    found = alliances.find(a => a.name.toLowerCase().includes(target));
    if (found) { logger.debug(`Contains match found: ${found.name}`); break; }

    if (!hasMore) {
      logger.debug('No more pages — alliance not found');
      break;
    }
    page++;
  }

  if (found) {
    setCache(key, found, CACHE_TIMES.alliance);
  } else {
    logger.warn(`Alliance "${name}" not found after searching ${page} page(s)`);
  }

  return found || null;
}

// ─────────────────────────────────────────────────────────────
// ALLIANCE MEMBERS — excludes applicants
// ─────────────────────────────────────────────────────────────
async function getAllianceMembers(allianceId) {
  const key = `alliance_members_${allianceId}`;
  const hit = getFromCache(key);
  if (hit) return hit;

  // We query nations() directly (not nested inside alliances) because the
  // nested nations field in the alliance query does NOT return missiles or nukes.
  // Querying nations() directly gives us the full military dataset.
  const data = await pwQuery(`
    query GetMembers($allianceId: [Int]) {
      nations(alliance_id: $allianceId, first: 500) {
        data {
          id
          nation_name
          score
          num_cities
          alliance_id
          alliance_position
          soldiers
          tanks
          aircraft
          ships
          missiles
          nukes
          spies
          beige_turns
          vacation_mode_turns
          offensive_wars_count
          defensive_wars_count
          last_active
        }
      }
    }
  `, { allianceId: [parseInt(allianceId)] });

  const all     = data?.nations?.data || [];
  const members = all.filter(n =>
    MEMBER_POSITIONS.includes((n.alliance_position || '').toUpperCase())
  );

  logger.debug(`Alliance ${allianceId}: ${all.length} total nations, ${members.length} actual members, ${all.length - members.length} applicants excluded`);
  setCache(key, members, CACHE_TIMES.alliance);
  return members;
}

// ─────────────────────────────────────────────────────────────
// WARS
// ─────────────────────────────────────────────────────────────
async function getNationWars(nationId) {
  const data = await pwQuery(`
    query GetWars($id: [Int]) {
      wars(nation_id: $id, active: true, first: 10) {
        data {
          id
          date
          attid
          defid
          att_alliance_id
          def_alliance_id
          attacker { nation_name score }
          defender { nation_name score }
          turnsleft
        }
      }
    }
  `, { id: [parseInt(nationId)] });
  return data?.wars?.data || [];
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function toTitleCase(s) {
  return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
function toSentenceCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function dedupe(arr) {
  return [...new Set(arr)];
}
function getFromCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl) {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}
function clearCache(key) {
  if (key) cache.delete(key); else cache.clear();
}

module.exports = {
  pwQuery,
  getNation, searchNationByName, resolveNation,
  getAllianceInfo, searchAllianceByName, resolveAlliance,
  getAllianceMembers, getNationWars,
  clearCache, MEMBER_POSITIONS,
};
