import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { formatCompact, makeLineChart } from './charts.js';
import { callApi } from './deltaforce.js';

const HISTORY_DAYS = 7;
const RECENT_MATCHES = 5;
const MAX_HISTORY_PAGES = 5;
const SEASON_TTL = 6 * 60 * 60 * 1000;
const FRESH_RECORD_MS = 10 * 60 * 1000;
const FRESH_RETRIES = 2;
const FRESH_RETRY_DELAY_MS = 4000;
export const LIFETIME = 'lifetime';

const formatNumber = (value, digits = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value ?? 0));
// The API documents these as ratios; accept either 0-1 or 0-100 to be safe.
const formatPercent = (ratio) => `${formatNumber(Number(ratio ?? 0) <= 1 ? Number(ratio ?? 0) * 100 : Number(ratio), 1)}%`;

function formatPlayTime(seconds) {
  const hours = Math.floor(Number(seconds ?? 0) / 3600);
  const minutes = Math.floor((Number(seconds ?? 0) % 3600) / 60);
  return hours ? `${formatNumber(hours)} ชม. ${minutes} นาที` : `${minutes} นาที`;
}

export const seasonLabel = (season) => `S${season.number} - ${season.name}`;

let seasonCache = null;

// All seasons, newest first. Cached because the list only changes when a new season starts.
export async function listSeasons(config) {
  if (!seasonCache || Date.now() - seasonCache.loadedAt > SEASON_TTL) {
    const seasons = [];
    let pageToken;
    do {
      const page = await callApi(config, 'ListSeasons', { pageSize: 100, language: 'LANGUAGE_EN', ...(pageToken && { pageToken }) });
      seasons.push(...(page.seasons ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    seasons.sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
    seasonCache = { seasons, loadedAt: Date.now() };
  }
  return seasonCache.seasons;
}

export class PlayerNotFoundError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accepts a display name, a numeric Delta Force ID, or the API's player UUID (used by the buttons).
export async function findPlayer(config, query) {
  const body = UUID.test(query) ? { id: query } : /^\d+$/.test(query) ? { deltaForceId: query } : { name: query };
  try {
    return (await callApi(config, 'GetPlayer', body)).player;
  } catch (error) {
    if (error.status === 404) throw new PlayerNotFoundError(query);
    throw error;
  }
}

async function fetchStashHistory(config, playerId) {
  const stashes = [];
  let pageToken;
  const startTime = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const result = await callApi(config, 'GetPlayerOperationHistoricalStashValue', {
      playerId, startTime, pageSize: 100, ...(pageToken && { pageToken }),
    });
    stashes.push(...(result.stashes ?? []));
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  return stashes;
}

// Missing stats or stash data (e.g. a player who never played Operations) come back as null instead of failing.
const optional = (promise) => promise.catch((error) => {
  if (error.status === 404) return null;
  throw error;
});

// seasonId: a season UUID, LIFETIME, or empty for the current season.
export async function fetchPlayerReport(config, query, { seasonId } = {}) {
  const player = await findPlayer(config, query);
  let season = null;
  if (seasonId && seasonId !== LIFETIME) {
    season = (await listSeasons(config)).find((entry) => entry.id === seasonId) ?? { id: seasonId };
  } else if (!seasonId) {
    season = (await optional(callApi(config, 'GetSeasonCurrent', {})))?.season ?? null;
  }
  // Some players only have ranked stats (the unranked lookup returns 404), so ask for both and show what exists.
  const statsFor = (ranked, seasonOfStats) => optional(callApi(config, 'GetPlayerOperationStats', {
    playerId: player.id, ranked, ...(seasonOfStats && { seasonId: seasonOfStats.id }),
  })).then((r) => r?.stats ?? null);
  const bothFor = (seasonOfStats) => Promise.all([statsFor(false, seasonOfStats), statsFor(true, seasonOfStats)]);

  const [[first, firstRanked], stash, history] = await Promise.all([
    bothFor(season),
    optional(callApi(config, 'GetPlayerOperationStashValue', { playerId: player.id })).then((r) => r?.stash ?? null),
    optional(fetchStashHistory(config, player.id)).then((r) => r ?? []),
  ]);
  let [unranked, ranked] = [first, firstRanked];

  // The API fetches a player from the game the first time anyone looks them up, so a brand-new record
  // can have no stats for a few seconds. Retry briefly before giving up.
  const fresh = Date.now() - new Date(player.createdAt ?? 0).getTime() < FRESH_RECORD_MS;
  for (let attempt = 0; fresh && !unranked && !ranked && attempt < FRESH_RETRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, FRESH_RETRY_DELAY_MS));
    [unranked, ranked] = await bothFor(season);
  }

  // Nothing in the chosen season (e.g. hasn't played Operations this season): show lifetime stats instead.
  let seasonFallback = false;
  if (!unranked && !ranked && season) {
    [unranked, ranked] = await bothFor(null);
    seasonFallback = Boolean(unranked || ranked);
  }

  return {
    player,
    season: seasonFallback ? null : season,
    requestedSeason: season,
    seasonFallback,
    fresh,
    stats: unranked ?? ranked,
    rankedOnly: !unranked && Boolean(ranked),
    stash,
    history,
  };
}

const stat = (label, value) => `${label}\n**${value}**`;

export async function makePlayerMessage({ player, season, requestedSeason, seasonFallback, fresh, stats, rankedOnly, stash, history }) {
  const period = `${season ? (season.number ? seasonLabel(season) : 'ซีซันที่เลือก') : 'ตลอดกาล'}${rankedOnly ? '  •  Ranked' : ''}`;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({ name: `Delta Force — Operations  •  ${period}` })
    .setTitle(player.name);

  const header = [`🎖️ Operations Lv. **${player.levelOperations ?? '-'}**  •  Warfare Lv. **${player.levelWarfare ?? '-'}**`];
  if (stats) {
    header.push(`⏱️ ${formatPlayTime(stats.playTime)}  •  🎮 ${formatNumber(stats.matchesPlayed)} แมตช์  •  🏆 Ranked ${formatNumber(stats.rankedPoints)} แต้ม`);
    // Same three groups as the "My Data" page on playdeltaforce.com.
    embed.addFields(
      {
        name: '💰 ข้อมูลเศรษฐกิจ',
        value: [
          stat('ถอนตัวสำเร็จ / ล้มเหลว', `${formatNumber(stats.matchesExtracted)} / ${formatNumber(stats.matchesLost)}`),
          stat('มูลค่าที่ขนออกมา', formatCompact(Number(stats.extractedAssets ?? 0))),
          stat('Mandelbrick ที่ขนออกมา', formatNumber(stats.extractedMandlebricks)),
        ].join('\n'),
        inline: true,
      },
      {
        name: '⚔️ ข้อมูลการต่อสู้',
        value: [
          stat('K/D', formatNumber(stats.kdRatio, 2)),
          stat('ฆ่าผู้เล่น', formatNumber(stats.totalKills)),
          stat('ความแม่น', formatPercent(stats.bulletDischargedHitRatio)),
          stat('ล้มด้วย Headshot', formatPercent(stats.knockedHeadshotRatio)),
        ].join('\n'),
        inline: true,
      },
      {
        name: '🤝 ข้อมูลทีม',
        value: [
          stat('อัตราถอนตัว', formatPercent(stats.extractionRate)),
          stat('มูลค่าที่เพื่อนขนออก', formatCompact(Number(stats.extractedTeammateAssets ?? 0))),
          stat('ช่วยชีวิตเพื่อน', formatNumber(stats.revives)),
          stat('เก็บป้ายเพื่อน', formatNumber(stats.pickups)),
        ].join('\n'),
        inline: true,
      },
    );
    if (seasonFallback) {
      const wanted = requestedSeason?.number ? seasonLabel(requestedSeason) : 'ซีซันที่เลือก';
      header.push(`ℹ️ ไม่มีสถิติ Operations ใน ${wanted} จึงแสดงสถิติตลอดกาลแทน`);
    }
  } else {
    // A player with Operations levels but no stats usually has hidden career data or an account the API can't read.
    const playsOperations = Number(player.levelOperations ?? 0) > 1;
    let reason;
    if (fresh) reason = 'API เพิ่งเริ่มดึงข้อมูลผู้เล่นนี้จากเกม สถิติยังไม่พร้อม ลอง `/player` อีกครั้งในอีกสักครู่';
    else if (playsOperations) reason = 'API ไม่มีสถิติของผู้เล่นนี้ (ผู้เล่นอาจตั้งค่าซ่อนประวัติในเกม หรือ API ยังดึงข้อมูลบัญชีนี้ไม่ได้) ลองใหม่ภายหลัง';
    else reason = 'ไม่มีสถิติโหมด Operations (ผู้เล่นอาจเล่นแต่ Warfare หรือยังไม่เคยเล่น Operations)';
    embed.addFields({ name: '📊 สถิติ', value: reason });
  }
  embed.setDescription(header.join('\n'));

  if (stash) {
    embed.addFields({
      name: '🏦 มูลค่าคลัง',
      // assetsNet is cash + equipment; the collection value is reported separately and not part of it.
      value: [
        `**${formatNumber(stash.assetsNet)}**  (เงินสด ${formatCompact(Number(stash.assetsLiquid ?? 0))} + อุปกรณ์ ${formatCompact(Number(stash.assetsFixed ?? 0))})`,
        `ของสะสม ${formatCompact(Number(stash.assetsCollection ?? 0))} (แยกต่างหาก)`,
      ].join('\n'),
    });
  }

  const pastNames = (player.nameHistory ?? []).map((entry) => entry.name).filter((name) => name && name !== player.name);
  const footer = [player.deltaForceId && `ID ${player.deltaForceId}`, pastNames.length && `เคยใช้ชื่อ: ${[...new Set(pastNames)].slice(0, 5).join(', ')}`].filter(Boolean);
  embed.setFooter({ text: [...footer, 'ข้อมูลจาก deltaforceapi.com'].join('  •  ') }).setTimestamp();

  const points = history.map((entry) => ({ at: new Date(entry.createdAt), value: Number(entry.assetsNet ?? 0) })).filter((point) => !Number.isNaN(point.at.getTime()));
  const chart = await makeLineChart(points, { title: `มูลค่าคลัง ${HISTORY_DAYS} วันล่าสุด` }).catch(() => null);
  if (!chart) return { embeds: [embed] };
  embed.setImage('attachment://stash-history.png');
  return { embeds: [embed], files: [{ attachment: chart, name: 'stash-history.png' }] };
}

// Overview / Recent matches toggle under a /player card. The custom id carries everything needed to redraw either view.
export function playerButtons(playerId, seasonKey, active) {
  const button = (view, label) => new ButtonBuilder()
    .setCustomId(`player|${view}|${playerId}|${seasonKey}`)
    .setLabel(label)
    .setStyle(view === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(view === active);
  return new ActionRowBuilder().addComponents(button('overview', '📊 ภาพรวม'), button('matches', '📜 แมตช์ล่าสุด'));
}

const toUnix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function eventResult(event) {
  if (event.matchesPlayed === 1) {
    return event.matchesExtracted > 0 ? '✅ ถอนตัวสำเร็จ' : event.matchesQuit > 0 ? '🏃 ออกกลางคัน' : '❌ ล้มเหลว';
  }
  const parts = [event.matchesExtracted && `✅${event.matchesExtracted}`, event.matchesLost && `❌${event.matchesLost}`, event.matchesQuit && `🏃${event.matchesQuit}`].filter(Boolean);
  return `🎮 ${event.matchesPlayed} แมตช์${parts.length ? ` (${parts.join(' ')})` : ''}`;
}

// An event is stamped with when the bot noticed it. When it merges several matches, or the bot was off for a while,
// that says little about when they were played, so show the window between the two checks instead.
function eventWindow(event, intervalMinutes) {
  if (!event.from) return null;
  const from = toUnix(event.from);
  const to = toUnix(event.at);
  if (event.matchesPlayed <= 1 && to - from <= intervalMinutes * 60 * 1.5) return null;
  return to - from > 24 * 60 * 60 ? `เล่นช่วง <t:${from}:f> – <t:${to}:f>` : `เล่นช่วง <t:${from}:t>–<t:${to}:t>`;
}

function eventExtras(event, intervalMinutes) {
  const extras = [eventWindow(event, intervalMinutes), `ฆ่า ${formatNumber(event.totalKills)}`, `ตาย ${formatNumber(event.totalDeaths)}`, `ขนออก ${formatCompact(event.extractedAssets)}`];
  if (event.extractedMandlebricks > 0) extras.push(`Mandelbrick ${event.extractedMandlebricks}`);
  return extras.filter(Boolean).join('  •  ');
}

function describeEvent(event, intervalMinutes) {
  return `<t:${toUnix(event.at)}:R>  ${eventResult(event)}\n└ ${eventExtras(event, intervalMinutes)}`;
}

// Posted in the stats channel when a tracked player finishes a match.
export function makeMatchNotification(playerName, event, { intervalMinutes }) {
  const extracted = event.matchesExtracted > 0 && event.matchesExtracted >= event.matchesLost;
  return {
    embeds: [new EmbedBuilder()
      .setColor(extracted ? 0x57f287 : 0xed4245)
      .setAuthor({ name: 'Delta Force — Operations  •  แมตช์ใหม่' })
      .setTitle(playerName)
      .setDescription(`${eventResult(event)}\n${eventExtras(event, intervalMinutes)}`)
      .setFooter({ text: event.matchesPlayed > 1 ? 'รวมหลายแมตช์ที่เล่นระหว่างการเช็กรอบก่อน' : 'ดูทั้งหมดได้ที่ปุ่ม 📜 แมตช์ล่าสุด ของ /player' })
      .setTimestamp(new Date(event.at))],
  };
}

export function makeMatchesMessage(playerName, tracking, { intervalMinutes }) {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setAuthor({ name: 'Delta Force — Operations  •  แมตช์ล่าสุด' })
    .setTitle(playerName);

  if (!tracking) {
    embed.setDescription(`กำลังเริ่มติดตามผู้เล่นนี้ บอตจะเช็กทุก ${intervalMinutes} นาที\nแมตช์ที่เล่นหลังจากนี้จะขึ้นที่นี่ ลองกดใหม่อีกครั้งภายหลัง`);
    return { embeds: [embed] };
  }

  const events = tracking.events.slice(0, RECENT_MATCHES);
  if (!events.length) {
    embed.setDescription(`ยังไม่มีแมตช์ใหม่ตั้งแต่เริ่มติดตาม (<t:${toUnix(tracking.startedAt)}:R>)\nบอตเช็กทุก ${intervalMinutes} นาที แมตช์ที่เล่นหลังจากนี้จะขึ้นที่นี่`);
  } else {
    const total = (key) => events.reduce((sum, event) => sum + event[key], 0);
    const matches = total('matchesPlayed');
    embed.setDescription([
      `**${events.length} รายการล่าสุด:** ${formatNumber(matches)} แมตช์  •  ถอนตัว ${formatPercent(total('matchesExtracted') / matches)}  •  ฆ่า ${formatNumber(total('totalKills'))}  •  ขนออก ${formatCompact(total('extractedAssets'))}`,
      '',
      ...events.map((event) => describeEvent(event, intervalMinutes)),
    ].join('\n').slice(0, 4_000));
  }
  embed.setFooter({ text: `ติดตามตั้งแต่ ${new Date(tracking.startedAt).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })}  •  เช็กทุก ${intervalMinutes} นาที  •  1 แถวอาจรวมหลายแมตช์ที่เล่นระหว่างการเช็ก` });
  return { embeds: [embed] };
}
