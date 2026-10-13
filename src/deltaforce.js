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
  if (!response.ok) {
    const error = new Error(`DeltaForce API ${method} responded with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
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

const RANK_COLORS = [0xf1c40f, 0xbdc3c7, 0xcd7f32];

function makeCraftEmbed(craft, rank, showRank) {
  const { profit, profitPerHour, roi } = calculateCraft(craft);
  const amount = craft.quantity > 1 ? `  •  ×${formatPrice(craft.quantity)}` : '';
  const embed = new EmbedBuilder()
    .setColor(RANK_COLORS[rank - 1] ?? 0x18a558)
    .setTitle(`${showRank ? `${rank}. ` : ''}${craft.item}${craft.tier ? ` T${craft.tier}` : ''}`)
    .setDescription([
      `🟢 **\`${formatPrice(profitPerHour)}\` / ชม.**  •  ${formatDuration(craft.minutes)}${amount}`,
      `กำไร \`${formatPrice(profit)}\` / รอบ${roi == null ? '' : `  •  ROI ${roi}%`}`,
      `ขายได้ \`${formatPrice(craft.sale)}\`  •  ต้นทุน \`${formatPrice(craft.materials)}\``,
    ].join('\n'));
  // The material card image is attached by makeWorkshopMessages; list the materials as text only without it.
  if (craft.materialList?.length && !craft.materialsImage) {
    embed.addFields({ name: 'วัตถุดิบ', value: formatMaterials(craft.materialList) });
  }
  if (craft.icon) embed.setThumbnail(craft.icon);
  return embed;
}

const SOURCE_NOTES = { crafted: '  ·  คราฟเอง', fixed: '  ·  ราคาประเมิน' };

function formatMaterials(materials) {
  const lines = materials.map((material) => {
    const each = material.quantity > 1 ? ` (${formatPrice(Math.round(material.unitPrice))}/ชิ้น)` : '';
    return `${material.name} ×${formatPrice(material.quantity)}  —  \`${formatPrice(material.total)}\`${each}${SOURCE_NOTES[material.source] ?? ''}`;
  });
  while (lines.join('\n').length > 1_024) lines.pop();
  return lines.join('\n');
}

// In-game order of the Black Site workshops, shown left to right, top to bottom in the 2×2 grid.
export const WORKSHOPS = ['Cyber Warfare Division', 'Workbench', 'Pharmacy', 'Armor Bench'];

// One cell per workshop with its best profitable craft. Workshops without recipes still get an empty cell.
export function workshopCells(groups) {
  const best = new Map(topCrafts(groups, 1).map(({ workshop, crafts }) => [workshop, crafts[0] ?? null]));
  const names = [...WORKSHOPS, ...[...best.keys()].filter((name) => !WORKSHOPS.includes(name))];
  return names.map((workshop) => {
    if (!best.has(workshop)) return { workshop, craft: null };
    const craft = best.get(workshop);
    return craft ? { workshop, craft } : { workshop, craft: null, message: 'ไม่มีสูตรที่ได้กำไรตอนนี้', hint: 'ราคาวัตถุดิบสูงกว่าราคาขาย' };
  });
}

function cellSummary(cell) {
  if (!cell.craft) return cell.message ?? 'ยังไม่มีสูตร';
  const { profit, profitPerHour } = calculateCraft(cell.craft);
  return `**${cell.craft.item}${cell.craft.tier ? ` T${cell.craft.tier}` : ''}**\n🟢 \`${formatPrice(profitPerHour)}\` / ชม.\nกำไร \`${formatPrice(profit)}\` / รอบ`;
}

// Text version of the grid (two cells per row; an empty inline field forces the line break) above the grid image.
export function makeWorkshopGridMessage(cells, { footer, notes = [], image }) {
  const spacer = { name: '​', value: '​', inline: true };
  const fields = cells.flatMap((cell, index) => {
    const field = { name: `🏭 ${cell.workshop}`, value: cellSummary(cell), inline: true };
    return index % 2 === 1 || index === cells.length - 1 ? [field, spacer] : [field];
  });
  const embed = new EmbedBuilder()
    .setColor(0x18a558)
    .setTitle('Black Site Workshop — คำแนะนำการคราฟ')
    .setDescription(['คราฟต์ที่แนะนำที่สุดในแต่ละแผนก', '`กำไร = ราคาขายหลังหักภาษี − ต้นทุนวัตถุดิบ`', ...notes].join('\n'))
    .addFields(fields)
    .setFooter({ text: footer })
    .setTimestamp();
  if (!image) return { embeds: [embed] };
  embed.setImage('attachment://workshops.png');
  return { embeds: [embed], files: [{ attachment: image, name: 'workshops.png' }] };
}

// The crafts a post shows: profitable ones only, best first, at most `top` per workshop.
export function topCrafts(groups, top) {
  const limit = Math.min(top, 10);
  return groups.map(({ workshop, crafts }) => ({
    workshop,
    crafts: crafts.filter((craft) => calculateCraft(craft).profitPerHour > 0).slice(0, limit),
  }));
}

// One embed per craft so each item can show its icon. The first embed of each workshop carries its name.
// Workshops are packed into as few messages as possible; Discord allows at most 10 embeds per message.
export function makeWorkshopMessages(groups, { footer, notes = [], top = 1 }) {
  const limit = Math.min(top, 10);
  const intro = [
    '**Black Site Workshop — คำแนะนำการคราฟ**',
    `${limit === 1 ? 'คราฟต์ที่แนะนำที่สุด' : `${limit} อันดับคราฟต์ที่กำไรต่อชั่วโมงสูงสุด`}ในแต่ละแผนก  •  \`กำไร = ราคาขายหลังหักภาษี − ต้นทุนวัตถุดิบ\``,
    ...notes,
  ].join('\n');

  // Each card is an embed plus an optional material image uploaded with the same message.
  const workshopCards = topCrafts(groups, limit).map(({ workshop, crafts: profitable }) => {
    const cards = profitable.length
      ? profitable.map((craft, rank) => ({ embed: makeCraftEmbed(craft, rank + 1, limit > 1), image: craft.materialsImage }))
      : [{ embed: new EmbedBuilder().setColor(0xe74c3c).setDescription('🔴 ไม่มีสูตรที่ได้กำไรตอนนี้') }];
    cards[0].embed.setAuthor({ name: `🏭 ${workshop}` });
    return cards;
  });

  const batches = [];
  for (const cards of workshopCards) {
    const last = batches.at(-1);
    if (last && last.length + cards.length <= 10) last.push(...cards);
    else batches.push([...cards]);
  }

  return batches.map((cards, index) => {
    const files = [];
    for (const { embed, image } of cards) {
      if (!image) continue;
      const name = `materials-${files.length + 1}.png`;
      files.push({ attachment: image, name });
      embed.setImage(`attachment://${name}`);
    }
    const embeds = cards.map(({ embed }) => embed);
    embeds.at(-1).setFooter({ text: footer }).setTimestamp();
    const message = { embeds };
    if (index === 0) message.content = intro;
    if (files.length) message.files = files;
    return message;
  });
}

// One craft on demand (/craft): the usual card plus where it ranks in its workshop and the materials card.
export function makeCraftDetailMessage(craft, { rank, total, image, footer }) {
  const embed = makeCraftEmbed({ ...craft, materialsImage: image }, rank, false)
    .setAuthor({ name: `🏭 ${craft.workshop}  •  อันดับ ${rank} จาก ${total} สูตร` })
    .setFooter({ text: footer })
    .setTimestamp();
  if (calculateCraft(craft).profitPerHour <= 0) embed.setColor(0xed4245);
  if (!image) return { embeds: [embed] };
  embed.setImage('attachment://materials.png');
  return { embeds: [embed], files: [{ attachment: image, name: 'materials.png' }] };
}

// Discord's image proxy cannot fetch from the DeltaForceAPI CDN, so download each thumbnail here
// and upload it with the message. Thumbnails that fail to download are dropped.
export async function attachThumbnails(message) {
  const files = [];
  for (const embed of message.embeds) {
    const url = embed.data.thumbnail?.url;
    if (!url?.startsWith('http')) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const name = `icon-${files.length + 1}.png`;
      files.push({ attachment: Buffer.from(await response.arrayBuffer()), name });
      embed.setThumbnail(`attachment://${name}`);
    } catch (error) {
      console.warn(`Could not download item icon ${url}: ${error.message}`);
      embed.setThumbnail(null);
    }
  }
  return files.length ? { ...message, files: [...(message.files ?? []), ...files] } : message;
}

export function makeDemoWorkshopMessages() {
  const demo = [
    { workshop: 'Cyber Warfare Division', item: 'Phantom Vertical Foregrip', sale: 18_200, materials: 13_650, minutes: 60 },
    { workshop: 'Workbench', item: '4.6×30mm AP SX', sale: 96_400, materials: 49_384, minutes: 60 },
    { workshop: 'Pharmacy', item: 'Precision Helmet Repair Kit', sale: 21_800, materials: 12_731, minutes: 60 },
    { workshop: 'Armor Bench', item: 'Elite Vest', sale: 68_700, materials: 42_756, minutes: 60 },
  ];
  return makeWorkshopMessages(
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
