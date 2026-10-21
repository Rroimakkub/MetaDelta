import { EmbedBuilder } from 'discord.js';
import { formatAmountChange, formatCompact, formatDate, makeLineChart } from './charts.js';
import { callApi } from './deltaforce.js';
import { currentWeek, zonedParts } from './time.js';

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

// Every page (up to MAX_HISTORY_PAGES of 100 records) of one of the API's history calls.
async function fetchHistory(config, method, listKey, body) {
  const records = [];
  let pageToken;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const result = await callApi(config, method, { ...body, pageSize: 100, ...(pageToken && { pageToken }) });
    records.push(...(result[listKey] ?? []));
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  return records;
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
  const startTime = new Date(week.start.getTime() - BASELINE_LOOKBACK_DAYS * DAY_MS).toISOString();
  // The weekly chart and activity are extras: if their history can't be loaded, show the card without them.
  const extra = (promise, what) => promise.catch((error) => {
    if (error.status !== 404) console.warn(`Could not load the ${what} of ${player.name}:`, error.message);
    return [];
  });
  const [[first, firstRanked], stash, history, statsHistory] = await Promise.all([
    bothFor(season),
    optional(callApi(config, 'GetPlayerOperationStashValue', { playerId: player.id })).then((r) => r?.stash ?? null),
    extra(fetchHistory(config, 'GetPlayerOperationHistoricalStashValue', 'stashes', { playerId: player.id, startTime }), 'stash history'),
    // Lifetime stats, so a new season starting mid-week doesn't reset the counts. The API returns nothing unless
    // `ranked: false` is sent explicitly (false means all matches, not only unranked ones).
    extra(fetchHistory(config, 'GetPlayerOperationHistoricalStats', 'stats', { playerId: player.id, ranked: false, startTime }), 'stats history'),
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
    statsHistory,
    week,
  };
}

const stat = (label, value) => `${label}\n**${value}**`;

// The stash over the current week: its value going into Monday (the last record before it, or the first record
// this week when the player has none earlier), its latest value, and the points to chart. A stash only changes
// when the API records it, so the chart holds each value until the next record and up to now.
function stashWeek(history, stash, { start, end }) {
  // The current stash is usually also the newest history record; keep one point per timestamp.
  const byTime = new Map([...history, ...(stash ? [stash] : [])]
    .map((entry) => ({ at: new Date(entry.createdAt), value: Number(entry.assetsNet ?? 0) }))
    .filter((point) => !Number.isNaN(point.at.getTime()))
    .map((point) => [point.at.getTime(), point]));
  const points = [...byTime.values()].sort((a, b) => a.at - b.at);
  const before = points.filter((point) => point.at < start);
  const during = points.filter((point) => point.at >= start && point.at < end);
  const baseline = before.at(-1) ?? during[0];
  if (!baseline) return null;
  const latest = during.at(-1) ?? baseline;
  const now = new Date(Math.min(Date.now(), end.getTime()));
  const chart = [...(before.length ? [{ at: start, value: baseline.value }] : []), ...during];
  if (chart.at(-1).at < now) chart.push({ at: now, value: latest.value });
  // Each record this week and how much it moved the stash (none for the first record when there is no earlier one).
  const records = during.map((point, index) => {
    const previous = index ? during[index - 1] : before.at(-1);
    return { ...point, change: previous ? point.value - previous.value : null };
  });
  return { baseline, latest, fromMonday: before.length > 0, change: latest.value - baseline.value, chart, records };
}

// What the player did this week, from the lifetime stats the API records at each refresh: the newest record minus
// the last one before Monday (or the first one this week when there is none earlier).
function activityWeek(statsHistory, { start, end }) {
  const records = statsHistory
    .map((entry) => ({ entry, at: new Date(entry.createdAt) }))
    .filter(({ at }) => !Number.isNaN(at.getTime()))
    .sort((a, b) => a.at - b.at);
  const before = records.filter(({ at }) => at < start);
  const during = records.filter(({ at }) => at >= start && at < end);
  const baseline = before.at(-1) ?? during[0];
  if (!baseline) return null;
  const latest = during.at(-1) ?? baseline;
  const gain = (key) => Math.max(0, Number(latest.entry[key] ?? 0) - Number(baseline.entry[key] ?? 0));
  return {
    fromMonday: before.length > 0,
    since: baseline.at,
    matches: gain('matchesPlayed'),
    extracted: gain('matchesExtracted'),
    kills: gain('totalKills'),
    extractedAssets: gain('extractedAssets'),
  };
}

const formatSigned = (change) => `${change > 0 ? '+' : '−'}${formatCompact(Math.abs(change))}`;

export async function makePlayerMessage({
  player, season, requestedSeason, seasonFallback, fresh, stats, rankedOnly, stash, history, statsHistory = [], week,
}) {
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
  const weeklyChange = weekly && formatAmountChange(weekly.change, weekly.baseline.value);
  if (stash || weekly) {
    // assetsNet is cash + equipment; the collection value is reported separately and not part of it.
    const lines = stash
      ? [
          `**${formatNumber(stash.assetsNet)}**  (เงินสด ${formatCompact(Number(stash.assetsLiquid ?? 0))} + อุปกรณ์ ${formatCompact(Number(stash.assetsFixed ?? 0))})`,
          `ของสะสม ${formatCompact(Number(stash.assetsCollection ?? 0))} (แยกต่างหาก)`,
        ]
      : [`**${formatNumber(weekly.latest.value)}**`];
    if (weekly) lines.push(`สัปดาห์นี้ **${weeklyChange}**${weekly.fromMonday ? '' : `  (นับตั้งแต่ ${formatDate(weekly.baseline.at, week.timeZone)})`}`);
    // The API records a stash only every ~15 hours, so say how old these numbers are.
    const recordedAt = stash?.createdAt ? new Date(stash.createdAt) : weekly.latest.at;
    if (!Number.isNaN(recordedAt.getTime())) lines.push(`ข้อมูลคลังอัปเดตล่าสุด <t:${Math.floor(recordedAt.getTime() / 1000)}:R>`);
    embed.addFields({ name: '🏦 มูลค่าคลัง', value: lines.join('\n') });
  }

  const activity = week ? activityWeek(statsHistory, week) : null;
  if (activity) {
    const since = activity.fromMonday ? '' : `  (นับตั้งแต่ ${formatDate(activity.since, week.timeZone)})`;
    const summary = activity.matches
      ? [
          `${formatNumber(activity.matches)} แมตช์`,
          `ถอนตัว ${formatNumber(activity.extracted)} (${Math.round((activity.extracted / activity.matches) * 100)}%)`,
          `ฆ่า ${formatNumber(activity.kills)}`,
          `ขนออก ${formatCompact(activity.extractedAssets)}`,
        ].join('  •  ')
      : 'ยังไม่มีแมตช์ที่ API บันทึกในสัปดาห์นี้';
    embed.addFields({ name: '🎮 กิจกรรมสัปดาห์นี้', value: `${summary}${since}` });
  }

  const pastNames = (player.nameHistory ?? []).map((entry) => entry.name).filter((name) => name && name !== player.name);
  const footer = [player.deltaForceId && `ID ${player.deltaForceId}`, pastNames.length && `เคยใช้ชื่อ: ${[...new Set(pastNames)].slice(0, 5).join(', ')}`].filter(Boolean);
  embed.setFooter({ text: [...footer, 'ข้อมูลจาก deltaforceapi.com'].join('  •  ') }).setTimestamp();

  let chart = null;
  if (weekly) {
    const { timeZone, days } = week;
    const sunday = days[6];
    const sameMonth = zonedParts(timeZone, week.start).month === zonedParts(timeZone, sunday).month;
    const range = `${formatDate(week.start, timeZone, { month: !sameMonth })}–${formatDate(sunday, timeZone)}`;
    chart = await makeLineChart(weekly.chart, {
      title: `มูลค่าคลัง สัปดาห์นี้ (${range})`,
      start: week.start,
      end: week.end,
      // Each day's label sits in the middle of that day.
      ticks: days.map((dayStart, index) => {
        const dayEnd = days[index + 1] ?? week.end;
        return { at: new Date((dayStart.getTime() + dayEnd.getTime()) / 2), label: `${WEEKDAYS[index]} ${formatDate(dayStart, timeZone, { month: false })}` };
      }),
      badge: { text: weeklyChange, color: weekly.change > 0 ? '#57f287' : weekly.change < 0 ? '#ed4245' : '#b5bac1' },
      step: true,
      // A ring at every record the API made this week, labelled with how much it moved the stash.
      markers: weekly.records.map(({ at, value, change }) => ({
        at,
        value,
        label: change ? formatSigned(change) : '',
        color: change > 0 ? '#57f287' : '#ed4245',
        below: change < 0,
      })),
      labelExtremes: true,
    }).catch(() => null);
  }
  if (!chart) return { embeds: [embed] };
  embed.setImage('attachment://stash-history.png');
  return { embeds: [embed], files: [{ attachment: chart, name: 'stash-history.png' }] };
}
