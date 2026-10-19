import sharp from 'sharp';
import { FONT, formatNumber } from './charts.js';

// Renders a craft's materials as one PNG: a row per material with its icon, name, quantity and price.
// Discord embeds take only one large image, so the material icons are drawn into a single card.
const WIDTH = 560;
const ROW = 100;
const TOP = 12;
const FOOTER = 66;
const ICON = 84;
const TEXT_X = 16 + ICON + 20;
const SOURCE_LABELS = { crafted: 'คราฟเอง', fixed: 'ราคาประเมิน' };

const iconCache = new Map(); // keyed by "size|url"

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function loadIcon(url, size = ICON) {
  const key = `${size}|${url}`;
  if (!iconCache.has(key)) {
    const icon = fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => sharp(Buffer.from(data))
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer());
    icon.catch(() => iconCache.delete(key));
    iconCache.set(key, icon);
  }
  return iconCache.get(key);
}

export async function makeMaterialsImage(materials, totalCost) {
  const height = TOP + materials.length * ROW + FOOTER;
  const shapes = [`<rect width="${WIDTH}" height="${height}" rx="12" fill="#2b2d31"/>`];
  const icons = [];

  for (const [index, material] of materials.entries()) {
    const y = TOP + index * ROW;
    // Materials without an icon get no image box; their text stays in the same column.
    const icon = material.icon ? await loadIcon(material.icon).catch(() => null) : null;
    if (icon) {
      shapes.push(`<rect x="16" y="${y + 4}" width="${ICON + 4}" height="${ICON + 4}" rx="12" fill="#1e1f22"/>`);
      icons.push({ input: icon, left: 18, top: y + 6 });
    }

    // Name on the first line; quantity details and the price share the second line so long names never hit the price.
    const details = [`×${formatNumber(material.quantity)}`];
    if (material.quantity > 1) details.push(`${formatNumber(material.unitPrice)}/ชิ้น`);
    if (SOURCE_LABELS[material.source]) details.push(SOURCE_LABELS[material.source]);
    shapes.push(
      `<text x="${TEXT_X}" y="${y + 40}" font-family="${FONT}" font-size="27" fill="#f2f3f5">${escapeXml(truncate(material.name, 30))}</text>`,
      `<text x="${TEXT_X}" y="${y + 77}" font-family="${FONT}" font-size="20" fill="#b5bac1">${escapeXml(details.join('  ·  '))}</text>`,
      `<text x="${WIDTH - 20}" y="${y + 78}" text-anchor="end" font-family="${FONT}" font-size="27" font-weight="bold" fill="#f1c40f">${formatNumber(material.total)}</text>`,
    );
  }

  const footerY = TOP + materials.length * ROW;
  shapes.push(
    `<line x1="16" y1="${footerY + 8}" x2="${WIDTH - 16}" y2="${footerY + 8}" stroke="#3f4147" stroke-width="2"/>`,
    `<text x="20" y="${footerY + 48}" font-family="${FONT}" font-size="23" fill="#b5bac1">รวมต้นทุนวัตถุดิบ</text>`,
    `<text x="${WIDTH - 20}" y="${footerY + 48}" text-anchor="end" font-family="${FONT}" font-size="28" font-weight="bold" fill="#ffffff">${formatNumber(totalCost)}</text>`,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">${shapes.join('')}</svg>`;
  return sharp(Buffer.from(svg)).composite(icons).png().toBuffer();
}
