import sharp from 'sharp';
import { FONT, formatNumber } from './charts.js';
import { calculateCraft } from './deltaforce.js';
import { loadIcon } from './recipe-card.js';

// Draws the best craft of each workshop as one 2×2 image. Each cell is laid out sideways (item on the left,
// materials on the right) so the picture is wide rather than tall: Discord scales tall images down more.
const CELL_WIDTH = 900;
const INFO_WIDTH = 460;
const GAP = 18;
const PAD = 28;
const ITEM_ICON = 140;
const MATERIAL_ICON = 58;
const MATERIAL_ROW = 72;
const MATERIALS_TOP = 70;
const MIN_HEIGHT = 330;
const SOURCE_LABELS = { crafted: 'คราฟเอง', fixed: 'ประเมิน' };

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const text = (x, y, size, fill, content, extra = '') => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(content)}</text>`;

function formatHours(minutes) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} ชม.` : `${Math.floor(hours)} ชม. ${minutes % 60} นาที`;
}

async function drawCell(cell, left, top, height, icons) {
  // Long workshop names shrink to stay clear of the materials column (a bold capital is about 0.62em wide).
  const title = cell.workshop.toUpperCase();
  const titleSize = Math.min(34, Math.floor((INFO_WIDTH - PAD - 16) / (title.length * 0.62)));
  const shapes = [
    `<rect x="${left}" y="${top}" width="${CELL_WIDTH}" height="${height}" rx="18" fill="#2b2d31"/>`,
    text(left + PAD, top + 50, titleSize, '#f1c40f', title, 'font-weight="bold" letter-spacing="1"'),
  ];

  const { craft } = cell;
  if (!craft) {
    shapes.push(
      text(left + CELL_WIDTH / 2, top + height / 2 + 14, 44, '#80848e', cell.message ?? 'ยังไม่มีสูตร', 'text-anchor="middle" font-weight="bold"'),
      
    );
    return shapes;
  }

  // Left: item icon, name, profit per hour and per run.
  const { profit, profitPerHour, roi } = calculateCraft(craft);
  const iconX = left + PAD;
  const iconY = top + 74;
  shapes.push(`<rect x="${iconX}" y="${iconY}" width="${ITEM_ICON + 8}" height="${ITEM_ICON + 8}" rx="16" fill="#1e1f22"/>`);
  const itemIcon = craft.icon ? await loadIcon(craft.icon, ITEM_ICON).catch(() => null) : null;
  if (itemIcon) icons.push({ input: itemIcon, left: iconX + 4, top: iconY + 4 });
  const details = [craft.tier && `T${craft.tier}`, craft.quantity > 1 && `×${formatNumber(craft.quantity)}`, formatHours(craft.minutes)].filter(Boolean).join(' · ');
  const textX = iconX + ITEM_ICON + 24;
  // Long item names get a smaller font (down to 30px) before they are cut short.
  const nameWidth = INFO_WIDTH - PAD - 16;
  const nameSize = Math.max(30, Math.min(40, Math.floor(nameWidth / (craft.item.length * 0.56))));
  shapes.push(
    text(textX, iconY + 44, 30, '#b5bac1', details),
    text(textX, iconY + 104, 50, '#57f287', formatNumber(profitPerHour), 'font-weight="bold"'),
    text(textX, iconY + 140, 28, '#57f287', 'ต่อชั่วโมง'),
    text(left + PAD, top + 268, nameSize, '#ffffff', truncate(craft.item, Math.floor(nameWidth / (nameSize * 0.56))), 'font-weight="bold"'),
    text(left + PAD, top + 312, 30, '#dbdee1', `กำไร ${formatNumber(profit)}${roi == null ? '' : ` · ROI ${roi}%`}`),
  );

  // Right: materials with icons and prices, then the total cost.
  const matLeft = left + INFO_WIDTH + 20;
  const right = left + CELL_WIDTH - PAD;
  shapes.push(
    `<line x1="${left + INFO_WIDTH}" y1="${top + 24}" x2="${left + INFO_WIDTH}" y2="${top + height - 24}" stroke="#3f4147" stroke-width="2"/>`,
    text(matLeft, top + 50, 28, '#b5bac1', 'วัตถุดิบ'),
    text(right, top + 50, 28, '#b5bac1', `ต้นทุน ${formatNumber(craft.materials)}`, 'text-anchor="end"'),
  );
  for (const [index, material] of (craft.materialList ?? []).entries()) {
    const rowY = top + MATERIALS_TOP + index * MATERIAL_ROW;
    const icon = material.icon ? await loadIcon(material.icon, MATERIAL_ICON).catch(() => null) : null;
    if (icon) {
      shapes.push(`<rect x="${matLeft}" y="${rowY}" width="${MATERIAL_ICON + 4}" height="${MATERIAL_ICON + 4}" rx="10" fill="#1e1f22"/>`);
      icons.push({ input: icon, left: matLeft + 2, top: rowY + 2 });
    }
    const nameX = matLeft + MATERIAL_ICON + 16;
    const label = SOURCE_LABELS[material.source] ? ` · ${SOURCE_LABELS[material.source]}` : '';
    // Name gets the whole first line; quantity and price share the second so long names never hit the price.
    shapes.push(
      text(nameX, rowY + 28, 28, '#f2f3f5', truncate(material.name, 22)),
      text(nameX, rowY + 60, 24, '#949ba4', `×${formatNumber(material.quantity)}${label}`),
      text(right, rowY + 60, 28, '#f1c40f', formatNumber(material.total), 'text-anchor="end" font-weight="bold"'),
    );
  }
  return shapes;
}

// cells: [{ workshop, craft | null, message?, hint? }] in display order (left to right, top to bottom).
export async function makeWorkshopGrid(cells) {
  const rows = Math.max(0, ...cells.map((cell) => cell.craft?.materialList?.length ?? 0));
  const cellHeight = Math.max(MIN_HEIGHT, MATERIALS_TOP + rows * MATERIAL_ROW + 20);
  const gridRows = Math.ceil(cells.length / 2);
  const width = CELL_WIDTH * 2 + GAP;
  const height = cellHeight * gridRows + GAP * (gridRows - 1);
  const shapes = [];
  const icons = [];
  for (const [index, cell] of cells.entries()) {
    const left = (index % 2) * (CELL_WIDTH + GAP);
    const top = Math.floor(index / 2) * (cellHeight + GAP);
    shapes.push(...(await drawCell(cell, left, top, cellHeight, icons)));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`;
  return sharp(Buffer.from(svg)).composite(icons).png().toBuffer();
}
