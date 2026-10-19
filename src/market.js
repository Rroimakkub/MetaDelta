import { EmbedBuilder } from 'discord.js';
import { formatCompact, formatNumber, makeLineChart } from './charts.js';
import { mapLimit } from './crafting.js';
import { callApi, catalogSnapshot, fetchMarketPrice, getCatalog, normalizeName } from './deltaforce.js';

const HISTORY_DAYS = 7;
const RECENT_HOURS = 12;
const BOARD_SIZE = 10;
const MOVERS = 3;
const HOUR_MS = 60 * 60 * 1000;
// Shown while the item list is still loading. Its value normalizes to nothing, so picking it matches no item.
const LOADING_CHOICE = { name: 'กำลังโหลดรายชื่อไอเทม ลองพิมพ์ใหม่ในอีกสักครู่', value: '-' };

const formatChange = (ratio) => `${ratio >= 0 ? '▲' : '▼'} ${Math.abs(ratio * 100).toFixed(1)}%`;
const isMarketItem = (item) => item.name && item.auctionable !== false;
const label = (item) => `${item.name}${item.quality ? ` · T${item.quality}` : ''}`;

// Market items with their normalized names, rebuilt only when a new catalog has been loaded.
let searchIndex = { source: null, entries: [] };
function marketIndex(items) {
  if (searchIndex.source !== items) {
    searchIndex = { source: items, entries: items.filter(isMarketItem).map((item) => ({ item, key: normalizeName(item.name) })) };
  }
  return searchIndex.entries;
}

// Autocomplete for /price: items sold on the market whose name contains what was typed.
export function suggestMarketItems(config, typed) {
  const items = catalogSnapshot(config);
  if (!items.length) return [LOADING_CHOICE];
  const key = normalizeName(typed);
  return marketIndex(items)
    .filter((entry) => entry.key.includes(key))
    .map((entry) => ({ ...entry, prefix: entry.key.startsWith(key) }))
    // Names that start with what was typed come first, then shorter names.
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.item.name.length - b.item.name.length)
    .slice(0, 25)
    .map(({ item }) => ({ name: label(item).slice(0, 100), value: item.id }));
}

// Finds an item by its autocomplete id, or by name when the text was typed without picking a suggestion.
export async function resolveMarketItem(config, query) {
  const entries = marketIndex(await getCatalog(config));
  const byId = entries.find((entry) => entry.item.id === query);
  if (byId) return byId.item;
  const key = normalizeName(query);
  if (!key) return null;
  const match = entries.find((entry) => entry.key === key)
    ?? entries.filter((entry) => entry.key.includes(key)).sort((a, b) => a.item.name.length - b.item.name.length)[0];
  return match?.item ?? null;
}

async function seriesSince(config, itemId, hours) {
  const startTime = new Date(Date.now() - hours * HOUR_MS).toISOString();
  const { prices = [] } = await callApi(config, 'GetItemAuctionPriceSeries', { itemId, startTime });
  return prices.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// Hourly price points (low, high and average) for the last HISTORY_DAYS days, oldest first. The API's 7-day series
// stops a few hours short of now (6 hours when checked), so the latest hours come from its 12-hour series, which
// has 15-minute points up to the present. Only one of those per hour is kept so recent hours don't outweigh the rest.
export async function fetchPriceSeries(config, itemId) {
  const [week, recent] = await Promise.all([seriesSince(config, itemId, HISTORY_DAYS * 24), seriesSince(config, itemId, RECENT_HOURS)]);
  const weekEnd = week.length ? new Date(week.at(-1).createdAt).getTime() : 0;
  return [...week, ...recent.filter((point) => {
    const at = new Date(point.createdAt);
    return at.getTime() > weekEnd && at.getUTCMinutes() === 0;
  })];
}

export async function makePriceMessage(item, { price, series, sellTaxPercent }) {
  const lines = [
    `💰 ราคาตอนนี้ **${formatNumber(price.price)}**`,
    `ขายได้จริงหลังหักภาษี ${sellTaxPercent}% ≈ **${formatNumber(price.price * (1 - sellTaxPercent / 100))}**`,
    '',
  ];
  if (series.length) {
    const average = series.reduce((sum, point) => sum + point.priceAvg, 0) / series.length;
    if (average > 0) {
      const difference = (price.price - average) / average;
      lines.push(`📊 เฉลี่ย ${HISTORY_DAYS} วัน **${formatNumber(average)}**  •  ${difference <= 0 ? '🟢 ตอนนี้ถูกกว่า' : '🔴 ตอนนี้แพงกว่า'}ค่าเฉลี่ย ${Math.abs(difference * 100).toFixed(1)}%`);
    }
    const low = Math.min(...series.map((point) => point.priceLow));
    const high = Math.max(...series.map((point) => point.priceHigh));
    lines.push(`ต่ำสุด ${formatNumber(low)}  •  สูงสุด ${formatNumber(high)}  (${HISTORY_DAYS} วัน)`);
  } else {
    lines.push(`ไม่มีข้อมูลราคาย้อนหลัง ${HISTORY_DAYS} วัน`);
  }
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({ name: 'Delta Force — ราคาตลาด' })
    .setTitle(label(item))
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'ราคาจาก deltaforceapi.com' })
    .setTimestamp(price.createdAt ? new Date(price.createdAt) : new Date());
  if (item.iconUrl) embed.setThumbnail(item.iconUrl);

  const points = series.map((point) => ({ at: new Date(point.createdAt), value: point.priceAvg }));
  const chart = await makeLineChart(points, { title: `ราคาเฉลี่ยรายชั่วโมง ${HISTORY_DAYS} วันล่าสุด` }).catch(() => null);
  if (!chart) return { embeds: [embed] };
  embed.setImage('attachment://price-history.png');
  return { embeds: [embed], files: [{ attachment: chart, name: 'price-history.png' }] };
}

// Red (T6) collectibles on the market: the current price (the same one /price shows) and its change from the
// average HISTORY_DAYS days ago. Items nobody is selling right now are left out, and the change stays empty when
// an item's price history doesn't reach back that far.
export async function getRedBoard(config) {
  const red = (await getCatalog(config)).filter((item) => isMarketItem(item) && item.quality === 6 && item.type === 'ITEM_TYPE_COLLECTIBLE');
  const results = await mapLimit(red, 4, async (item) => {
    const [price, week] = await Promise.all([
      fetchMarketPrice(config, { id: item.id, name: item.name }),
      seriesSince(config, item.id, HISTORY_DAYS * 24).catch(() => []),
    ]);
    return { price: Number(price.price), week };
  });
  const windowStart = Date.now() - HISTORY_DAYS * 24 * HOUR_MS;
  return red.flatMap((item, index) => {
    if (results[index].status !== 'fulfilled') return [];
    const { price, week } = results[index].value;
    const baseline = week[0];
    const coversWeek = baseline && new Date(baseline.createdAt).getTime() - windowStart < 24 * HOUR_MS;
    return [{ item, price, change: coversWeek && baseline.priceAvg > 0 ? (price - baseline.priceAvg) / baseline.priceAvg : null }];
  });
}

export function makeRedBoardMessage(entries) {
  const top = [...entries].sort((a, b) => b.price - a.price).slice(0, BOARD_SIZE);
  const risers = entries.filter((entry) => entry.change > 0).sort((a, b) => b.change - a.change).slice(0, MOVERS);
  const fallers = entries.filter((entry) => entry.change < 0).sort((a, b) => a.change - b.change).slice(0, MOVERS);
  const line = ({ item, price, change }) => `**${item.name}** ${formatCompact(price)}${change == null ? '' : `  ${formatChange(change)}`}`;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`💎 ของแดงราคาสูงสุด — Top ${top.length}`)
    .setDescription(top.map((entry, index) => `${index + 1}. ${line(entry)}`).join('\n'))
    .setFooter({ text: `ราคาตลาดตอนนี้ เทียบกับราคาเฉลี่ยเมื่อ ${HISTORY_DAYS} วันก่อน  •  ดูกราฟแต่ละชิ้นด้วย /price  •  ราคาจาก deltaforceapi.com` })
    .setTimestamp();
  const fields = [];
  if (risers.length) fields.push({ name: `📈 ขึ้นแรงสุด ${HISTORY_DAYS} วัน`, value: risers.map(line).join('\n'), inline: true });
  if (fallers.length) fields.push({ name: `📉 ลงแรงสุด ${HISTORY_DAYS} วัน`, value: fallers.map(line).join('\n'), inline: true });
  if (fields.length) embed.addFields(fields);
  if (top[0]?.item.iconUrl) embed.setThumbnail(top[0].item.iconUrl);
  return { embeds: [embed] };
}
