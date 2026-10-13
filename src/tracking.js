import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callApi } from './deltaforce.js';

// DeltaForceAPI has no per-match history and only records a player's stats when someone looks them up.
// The bot polls tracked players and turns the difference between two lookups into "recent match" events.
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const file = path.join(directory, 'tracking.json');
export const MAX_PLAYERS_PER_GUILD = 50;
const MAX_EVENTS = 50;
// /player tracks every player it shows. Those auto-tracked players stop being polled after this long without a view;
// players added with /track add are pinned and never expire.
const EXPIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const COUNTERS = ['matchesPlayed', 'matchesExtracted', 'matchesLost', 'matchesQuit', 'totalKills', 'totalDeaths', 'extractedAssets', 'extractedMandlebricks', 'playTime'];

let state = null;
let loading = null;
let saving = Promise.resolve();
let polling = null;

// Reads the file once. Callers that arrive while it is loading share the same promise, so two early
// callers can't each read the file and overwrite the other's changes.
function load() {
  if (state) return Promise.resolve(state);
  loading ??= readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return { guilds: {}, players: {} };
    })
    .then((data) => {
      state = data;
      return state;
    })
    .finally(() => { loading = null; });
  return loading;
}

function save() {
  saving = saving.then(async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  });
  return saving;
}

// Lifetime stats as plain numbers. Some players only have ranked stats, so fall back to those.
async function fetchSnapshot(config, playerId) {
  for (const ranked of [false, true]) {
    try {
      const { stats } = await callApi(config, 'GetPlayerOperationStats', { playerId, ranked });
      if (stats) return { ranked, at: new Date().toISOString(), ...Object.fromEntries(COUNTERS.map((key) => [key, Number(stats[key] ?? 0)])) };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return null;
}

function removeFromGuild(data, guildId, playerId) {
  data.guilds[guildId] = (data.guilds[guildId] ?? []).filter((id) => id !== playerId);
  if (!Object.values(data.guilds).some((ids) => ids.includes(playerId))) delete data.players[playerId];
}

// pinned: true for /track add (never expires); false for the automatic tracking done by /player.
// When a server is full, the auto-tracked player viewed longest ago makes room.
export async function trackPlayer(config, guildId, player, { pinned = false } = {}) {
  const data = await load();
  const list = data.guilds[guildId] ?? [];
  const existing = data.players[player.id];
  if (list.includes(player.id) && existing) {
    existing.lastViewedAt = new Date().toISOString();
    const wasPinned = existing.pinned;
    if (pinned) existing.pinned = true;
    await save();
    return { added: false, reason: 'already', pinnedNow: pinned && !wasPinned };
  }
  if (list.length >= MAX_PLAYERS_PER_GUILD) {
    const evictable = list.map((id) => ({ id, ...data.players[id] })).filter((entry) => !entry.pinned)
      .sort((a, b) => new Date(a.lastViewedAt ?? a.startedAt) - new Date(b.lastViewedAt ?? b.startedAt));
    if (!evictable.length) return { added: false, reason: 'full' };
    removeFromGuild(data, guildId, evictable[0].id);
  }
  if (!data.players[player.id]) {
    data.players[player.id] = { name: player.name, startedAt: new Date().toISOString(), last: await fetchSnapshot(config, player.id), events: [] };
  }
  Object.assign(data.players[player.id], { lastViewedAt: new Date().toISOString(), ...(pinned && { pinned: true }) });
  data.guilds[guildId] = [...new Set([...(data.guilds[guildId] ?? []), player.id])];
  await save();
  return { added: true };
}

export async function untrackPlayer(guildId, name) {
  const data = await load();
  const playerId = (data.guilds[guildId] ?? []).find((id) => data.players[id]?.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!playerId) return null;
  const { name: playerName } = data.players[playerId];
  removeFromGuild(data, guildId, playerId);
  await save();
  return playerName;
}

// Marks a player as recently viewed so automatic tracking keeps going.
export async function touchPlayer(playerId) {
  const data = await load();
  if (!data.players[playerId]) return;
  data.players[playerId].lastViewedAt = new Date().toISOString();
  await save();
}

export async function listTracked(guildId) {
  const data = await load();
  return (data.guilds[guildId] ?? []).map((id) => ({ id, ...data.players[id] })).filter((player) => player.name);
}

export async function getTracking(playerId) {
  return (await load()).players[playerId] ?? null;
}

function diff(previous, current) {
  return Object.fromEntries(COUNTERS.map((key) => [key, current[key] - previous[key]]));
}

// Returns the new match event, or null when nothing changed.
async function pollPlayer(config, playerId, tracked) {
  // GetPlayer refreshes the player's record; the stash lookup also feeds the API's stash history (used by the chart).
  const { player } = await callApi(config, 'GetPlayer', { id: playerId });
  if (player?.name) tracked.name = player.name;
  await callApi(config, 'GetPlayerOperationStashValue', { playerId }).catch(() => null);
  const snapshot = await fetchSnapshot(config, playerId);
  if (!snapshot) return null;
  const previous = tracked.last;
  tracked.last = snapshot;
  if (!previous || previous.ranked !== snapshot.ranked) return null;
  const change = diff(previous, snapshot);
  if (change.matchesPlayed <= 0) return null;
  const event = { from: previous.at, at: snapshot.at, ...change };
  tracked.events = [event, ...tracked.events].slice(0, MAX_EVENTS);
  return event;
}

function dropExpired(data) {
  const cutoff = Date.now() - EXPIRE_AFTER_MS;
  for (const [playerId, tracked] of Object.entries(data.players)) {
    if (tracked.pinned || new Date(tracked.lastViewedAt ?? tracked.startedAt).getTime() > cutoff) continue;
    for (const guildId of Object.keys(data.guilds)) data.guilds[guildId] = data.guilds[guildId].filter((id) => id !== playerId);
    delete data.players[playerId];
  }
}

async function pollOnce(config) {
  const data = await load();
  dropExpired(data);
  const newEvents = [];
  for (const [playerId, tracked] of Object.entries(data.players)) {
    try {
      const event = await pollPlayer(config, playerId, tracked);
      if (!event) continue;
      const guildIds = Object.entries(data.guilds).filter(([, ids]) => ids.includes(playerId)).map(([guildId]) => guildId);
      newEvents.push({ playerId, name: tracked.name, pinned: Boolean(tracked.pinned), guildIds, event });
    } catch (error) {
      console.warn(`Could not poll player ${tracked.name}: ${error.message}`);
    }
  }
  await save();
  return newEvents;
}

// Checks every tracked player once and resolves to the new match events
// ({ playerId, name, pinned, guildIds, event }). Errors for one player don't stop the others.
// A poll that is still running is reused instead of starting a second one: two overlapping polls
// would diff the same previous snapshot and record every match twice.
export function pollTrackedPlayers(config) {
  polling ??= pollOnce(config).finally(() => { polling = null; });
  return polling;
}
