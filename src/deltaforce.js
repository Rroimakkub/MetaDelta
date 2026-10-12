import { EmbedBuilder } from 'discord.js';

export async function callApi(config, method, body) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
  };
  if (config.apiToken) headers['deltaforceapi-gateway-key'] = config.apiToken;

  const response = await fetch(`${config.apiBaseUrl}/deltaforceapi.gateway.ApiService/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DeltaForce API ${method} responded with HTTP ${response.status}.`);
  return response.json();
}

export async function fetchMarketPrice(config, item) {
  if (config.demoMode) {
    const prices = {
      'demo-foregrip': 4_550,
      'demo-ammo': 47_016,
      'demo-kit': 9_069,
      'demo-vest': 25_944,
    };
    return {
      item,
      price: prices[item.id] ?? 0,
      referencePrice: 0,
      durabilityRatio: null,
      createdAt: new Date().toISOString(),
    };
  }
  const data = await callApi(config, 'GetItemAuctionPrice', { itemId: item.id });
  if (data.price?.price == null) throw new Error(`No market price for ${item.name}.`);
  return { ...data.price, item };
}

export async function listAllItems(config) {
  const items = [];
  let pageToken;
  do {
    const page = await callApi(config, 'ListItems', { pageSize: 100, language: 'LANGUAGE_EN', ...(pageToken && { pageToken }) });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

const CATALOG_TTL = 6 * 60 * 60 * 1000;
let catalog = null;

function getCatalog(config) {
  if (!catalog || Date.now() - catalog.loadedAt > CATALOG_TTL) {
    const items = listAllItems(config);
    catalog = { items, loadedAt: Date.now() };
    items.catch(() => { catalog = null; });
  }
  return catalog.items;
}

export function normalizeName(name) {
  return String(name ?? '').toLocaleLowerCase().replace(/×/g, 'x').replace(/[^a-z0-9]/g, '');
}

// Matches an exact name first, then (when a quality tier is given) a unique item whose name starts with it,
// so spreadsheet shorthand like "5.7x28mm" + tier 5 still resolves to the full in-game name.
// Some names exist twice (one copy not sold on the market), so market items win ties.
export async function findItem(config, name, quality) {
  const items = (await getCatalog(config)).filter((item) => item.name);
  const key = normalizeName(name);
  const pick = (list) => {
    const tiered = quality == null ? list : list.filter((item) => item.quality === quality);
    const onMarket = tiered.filter((item) => item.auctionable !== false);
    return onMarket.length ? onMarket : tiered;
  };
  const exact = items.filter((item) => normalizeName(item.name) === key);
  if (exact.length && (pick(exact).length || quality == null)) return pick(exact)[0] ?? exact[0];

  const prefixed = pick(items.filter((item) => normalizeName(item.name).startsWith(key)));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    const names = prefixed.slice(0, 5).map((item) => item.name).join(', ');
    throw new Error(`"${name}"${quality == null ? '' : ` T${quality}`} matches several items (${names}). Use the full name.`);
  }
  throw new Error(`Item "${name}" not found. Check the English name with npm run find-items.`);
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

export function calculateCraft({ sale, materials, minutes }) {
  const profit = sale - materials;
  return {
    profit,
    profitPerHour: Math.floor((profit / minutes) * 60),
    roi: materials ? Math.round((profit / materials) * 100) : null,
  };
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} นาที`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} ชม. ${minutes % 60} นาที` : `${hours} ชม.`;
}

function formatCraftLine(craft, rank) {
  const { profit, profitPerHour, roi } = calculateCraft(craft);
  const amount = craft.quantity > 1 ? ` ×${formatPrice(craft.quantity)}` : '';
  return [
    `**${rank}. ${craft.item}**${craft.tier ? ` T${craft.tier}` : ''}${amount}  •  ${formatDuration(craft.minutes)}`,
    `└ 🟢 **\`${formatPrice(profitPerHour)}\` / ชม.**  •  กำไร \`${formatPrice(profit)}\`  •  ต้นทุน \`${formatPrice(craft.materials)}\`${roi == null ? '' : `  •  ROI ${roi}%`}`,
  ].join('\n');
}

export function makeWorkshopEmbed(groups, { footer, notes = [], top = 5 }) {
  const fields = groups.map(({ workshop, crafts }) => {
    const profitable = crafts.filter((craft) => calculateCraft(craft).profitPerHour > 0).slice(0, top);
    const lines = profitable.map((craft, index) => formatCraftLine(craft, index + 1));
    while (lines.join('\n').length > 1_024) lines.pop();
    return {
      name: `🏭 ${workshop}`,
      value: lines.length ? lines.join('\n') : '🔴 ไม่มีสูตรที่ได้กำไรตอนนี้',
      inline: false,
    };
  });

  const description = [`${top} อันดับคราฟต์ที่กำไรต่อชั่วโมงสูงสุดในแต่ละแผนก`, '`กำไร = ราคาขายหลังหักภาษี − ต้นทุนวัตถุดิบ`', ...notes];
  return new EmbedBuilder()
    .setColor(0x18a558)
    .setTitle('Black Site Workshop — คำแนะนำการคราฟ')
    .setDescription(description.join('\n').slice(0, 4_000))
    .addFields(fields.slice(0, 25))
    .setFooter({ text: footer })
    .setTimestamp();
}

export function makeDemoWorkshopEmbed() {
  const demo = [
    { workshop: 'Cyber Warfare Division', item: 'Phantom Vertical Foregrip', sale: 18_200, materials: 13_650, minutes: 60 },
    { workshop: 'Workbench', item: '4.6×30mm AP SX', sale: 96_400, materials: 49_384, minutes: 60 },
    { workshop: 'Pharmacy', item: 'Precision Helmet Repair Kit', sale: 21_800, materials: 12_731, minutes: 60 },
    { workshop: 'Armor Bench', item: 'Elite Vest', sale: 68_700, materials: 42_756, minutes: 60 },
  ];
  return makeWorkshopEmbed(
    demo.map((craft) => ({ workshop: craft.workshop, crafts: [{ quantity: 1, ...craft }] })),
    { footer: 'ข้อมูลตัวอย่างสำหรับทดสอบ' },
  );
}

export function makeMarketEmbed(prices) {
  const lines = prices.map(({ item, price, referencePrice, durabilityRatio, createdAt }) => {
    const reference = referencePrice ? ` · อ้างอิง ${formatPrice(referencePrice)}` : '';
    const durability = durabilityRatio == null ? '' : ` · ความทนทาน ${durabilityRatio}%`;
    const timestamp = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : null;
    return `**${item.name}**\nราคา: \`${formatPrice(price)}\`${reference}${durability}${timestamp ? `\nอัปเดต: <t:${timestamp}:R>` : ''}`;
  });
  return new EmbedBuilder()
    .setColor(0x18a558)
    .setTitle('Delta Force — ราคาตลาด')
    .setDescription(lines.join('\n\n').slice(0, 4_000))
    .setFooter({ text: prices.some(({ item }) => item.id.startsWith('demo-')) ? 'ข้อมูลตัวอย่างสำหรับทดสอบ' : 'ข้อมูลจาก deltaforceapi.com' })
    .setTimestamp();
}
