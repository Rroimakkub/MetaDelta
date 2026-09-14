import 'dotenv/config';

const required = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'];

function parseMarketItems(value) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const items = value.split(',').map((part) => {
    const [id, ...nameParts] = part.trim().split('|');
    return { id, name: nameParts.join('|').trim() };
  });
  if (!items.length || items.some(({ id, name }) => !uuid.test(id) || !name)) {
    throw new Error('MARKET_ITEMS must contain UUID|item name entries separated by commas.');
  }
  return items;
}

export function getConfig() {
  const demoMode = process.env.DEMO_MODE === 'true';
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}. Copy .env.example to .env first.`);
  }

  const postTime = process.env.POST_TIME ?? '09:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(postTime)) {
    throw new Error('POST_TIME must use HH:MM format, for example 09:00.');
  }

  return {
    botToken: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    apiToken: process.env.DELTAFORCE_API_TOKEN ?? '',
    apiBaseUrl: (process.env.DELTAFORCE_API_BASE_URL ?? 'https://api.deltaforceapi.com').replace(/\/$/, ''),
    demoMode,
    marketItems: demoMode
      ? [
          { id: 'demo-foregrip', name: 'Phantom Vertical Foregrip' },
          { id: 'demo-ammo', name: '4.6×30mm AP SX' },
          { id: 'demo-kit', name: 'Precision Helmet Repair Kit' },
          { id: 'demo-vest', name: 'Elite Vest' },
        ]
      : parseMarketItems(process.env.MARKET_ITEMS ?? ''),
    timeZone: process.env.TIME_ZONE ?? 'Asia/Bangkok',
    postTime,
  };
}
