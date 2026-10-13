import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const file = path.join(directory, 'channels.json');

async function read() {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function save(data) {
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// Per-server settings: 'market' and 'stats' channel ids, and 'trackerRole' (role allowed to use /track add/remove).
// Older files stored a single channel id per server; that is treated as the market channel.
const channelsOf = (entry) => (typeof entry === 'string' ? { market: entry } : entry ?? {});

export async function setGuildSetting(guildId, key, value) {
  const settings = await read();
  const next = { ...channelsOf(settings[guildId]), [key]: value };
  if (value == null) delete next[key];
  settings[guildId] = next;
  await save(settings);
}

export async function getGuildSetting(guildId, key) {
  return channelsOf((await read())[guildId])[key] ?? null;
}

export const setChannel = (guildId, channelId, kind = 'market') => setGuildSetting(guildId, kind, channelId);
export const getChannel = (guildId, kind = 'market') => getGuildSetting(guildId, kind);

export async function getAllChannels(kind = 'market') {
  return Object.entries(await read())
    .map(([guildId, entry]) => ({ guildId, channelId: channelsOf(entry)[kind] }))
    .filter(({ channelId }) => channelId);
}
