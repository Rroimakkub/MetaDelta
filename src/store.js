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

export async function setChannel(guildId, channelId) {
  const channels = await read();
  channels[guildId] = channelId;
  await save(channels);
}

export async function getChannel(guildId) {
  return (await read())[guildId] ?? null;
}

export async function getAllChannels() {
  return Object.entries(await read()).map(([guildId, channelId]) => ({ guildId, channelId }));
}
