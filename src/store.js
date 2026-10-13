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

// Each server has a channel per kind: 'market' (daily craft post) and 'stats' (/player cards).
// Older files stored a single channel id per server; that is treated as the market channel.
const channelsOf = (entry) => (typeof entry === 'string' ? { market: entry } : entry ?? {});

export async function setChannel(guildId, channelId, kind = 'market') {
  const channels = await read();
  channels[guildId] = { ...channelsOf(channels[guildId]), [kind]: channelId };
  await save(channels);
}

export async function getChannel(guildId, kind = 'market') {
  return channelsOf((await read())[guildId])[kind] ?? null;
}

export async function getAllChannels(kind = 'market') {
  return Object.entries(await read())
    .map(([guildId, entry]) => ({ guildId, channelId: channelsOf(entry)[kind] }))
    .filter(({ channelId }) => channelId);
}
