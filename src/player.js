import { EmbedBuilder } from 'discord.js';
import { formatCompact, makeLineChart } from './charts.js';
import { callApi } from './deltaforce.js';

// The stash chart covers the current week; history from this many days before Monday supplies the value
// carried into the week (the API records a stash only about twice a day).
const BASELINE_LOOKBACK_DAYS = 28;
const MAX_HISTORY_PAGES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
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

// Accepts a display name, a numeric Delta Force ID, or the API's player UUID.
export async function findPlayer(config, query) {
  const body = UUID.test(query) ? { id: query } : /^\d+$/.test(query) ? { deltaForceId: query } : { name: query };
  try {
    return (await callApi(config, 'GetPlayer', body)).player;
  } catch (error) {
    if (error.status === 404) throw new PlayerNotFoundError(query);
    throw error;
  }
}

// Monday 00:00 up to the next Monday 00:00 of the current week, in `timeZone`.
export function currentWeek(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const wallClock = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = wallClock - Math.floor(now.getTime() / 1000) * 1000;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const start = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - weekday) - offset);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS), timeZone };
}

async function fetchStashHistory(config, playerId, since) {
  const stashes = [];
  let pageToken;
  const startTime = since.toISOString();
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

  const week = currentWeek(config.timeZone);
  const [[first, firstRanked], stash, history] = await Promise.all([
    bothFor(season),
    optional(callApi(config, 'GetPlayerOperationStashValue', { playerId: player.id })).then((r) => r?.stash ?? null),
    // The chart is extra: if its history can't be loaded, show the card without it.
    fetchStashHistory(config, player.id, new Date(week.start.getTime() - BASELINE_LOOKBACK_DAYS * DAY_MS)).catch((error) => {
      if (error.status !== 404) console.warn(`Could not load the stash history of ${player.name}:`, error.message);
      return [];
    }),
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
    week,
  };
}

const stat = (label, value) => `${label}\n**${value}**`;

// The stash over the current week: its value going into Monday (the last record before it, or the first record
// this week when the player has none earlier), its latest value, and the points to chart. A stash only changes
// when the API records it, so the chart holds each value until the next record and up to now.
function stashWeek(history, stash, { start, end }) {
  const seen = new Set();
  const points = [...history, ...(stash ? [stash] : [])]
    .map((entry) => ({ at: new Date(entry.createdAt), value: Number(entry.assetsNet ?? 0) }))
    .filter((point) => !Number.isNaN(point.at.getTime()) && !seen.has(point.at.getTime()) && seen.add(point.at.getTime()))
    .sort((a, b) => a.at - b.at);
  const before = points.filter((point) => point.at < start);
  const during = points.filter((point) => point.at >= start && point.at < end);
  const baseline = before.at(-1) ?? during[0];
  if (!baseline) return null;
  const latest = during.at(-1) ?? baseline;
  const now = new Date(Math.min(Date.now(), end.getTime()));
  const chart = [...(before.length ? [{ at: start, value: baseline.value }] : []), ...during];
  if (chart.at(-1).at < now) chart.push({ at: now, value: latest.value });
  return { baseline, latest, fromMonday: before.length > 0, change: latest.value - baseline.value, chart };
}

function formatStashChange({ change, baseline }) {
  const sign = change > 0 ? '▲ +' : change < 0 ? '▼ −' : '± ';
  const percent = baseline.value ? `  (${change >= 0 ? '+' : '−'}${Math.abs((change / baseline.value) * 100).toFixed(1)}%)` : '';
  return `${sign}${formatCompact(Math.abs(change))}${percent}`;
}

export async function makePlayerMessage({ player, season, requestedSeason, seasonFallback, fresh, stats, rankedOnly, stash, history, week }) {
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

  const weekly = week ? stashWeek(history, stash, week) : null;
  const dayMonth = (date) => date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: week?.timeZone });
  if (stash) {
    const lines = [
      `**${formatNumber(stash.assetsNet)}**  (เงินสด ${formatCompact(Number(stash.assetsLiquid ?? 0))} + อุปกรณ์ ${formatCompact(Number(stash.assetsFixed ?? 0))})`,
      `ของสะสม ${formatCompact(Number(stash.assetsCollection ?? 0))} (แยกต่างหาก)`,
    ];
    if (weekly) lines.push(`สัปดาห์นี้ **${formatStashChange(weekly)}**${weekly.fromMonday ? '' : `  (นับตั้งแต่ ${dayMonth(weekly.baseline.at)})`}`);
    // assetsNet is cash + equipment; the collection value is reported separately and not part of it.
    embed.addFields({ name: '🏦 มูลค่าคลัง', value: lines.join('\n') });
  }

  const pastNames = (player.nameHistory ?? []).map((entry) => entry.name).filter((name) => name && name !== player.name);
  const footer = [player.deltaForceId && `ID ${player.deltaForceId}`, pastNames.length && `เคยใช้ชื่อ: ${[...new Set(pastNames)].slice(0, 5).join(', ')}`].filter(Boolean);
  embed.setFooter({ text: [...footer, 'ข้อมูลจาก deltaforceapi.com'].join('  •  ') }).setTimestamp();

  let chart = null;
  if (weekly) {
    const day = (date) => date.toLocaleDateString('th-TH', { day: 'numeric', timeZone: week.timeZone });
    const sunday = new Date(week.start.getTime() + 6.5 * DAY_MS);
    const sameMonth = dayMonth(week.start).split(' ')[1] === dayMonth(sunday).split(' ')[1];
    const range = `${sameMonth ? day(week.start) : dayMonth(week.start)}–${dayMonth(sunday)}`;
    chart = await makeLineChart(weekly.chart, {
      title: `มูลค่าคลัง สัปดาห์นี้ (${range})`,
      start: week.start,
      end: week.end,
      ticks: WEEKDAYS.map((name, index) => {
        const noon = new Date(week.start.getTime() + (index + 0.5) * DAY_MS);
        return { at: noon, label: `${name} ${day(noon)}` };
      }),
      badge: { text: formatStashChange(weekly), color: weekly.change > 0 ? '#57f287' : weekly.change < 0 ? '#ed4245' : '#b5bac1' },
      step: true,
    }).catch(() => null);
  }
  if (!chart) return { embeds: [embed] };
  embed.setImage('attachment://stash-history.png');
  return { embeds: [embed], files: [{ attachment: chart, name: 'stash-history.png' }] };
}
