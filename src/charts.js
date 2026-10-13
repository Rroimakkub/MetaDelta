import sharp from 'sharp';

const WIDTH = 800;
const HEIGHT = 300;
const PAD = { top: 48, right: 24, bottom: 40, left: 84 };
const FONT = 'Segoe UI, Leelawadee UI, Tahoma, sans-serif';

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

export function formatCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

const formatDate = (date) => date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });

// Draws a line chart of { at: Date, value: number } points as a PNG. Returns null with fewer than 2 points.
export async function makeLineChart(points, { title }) {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const values = sorted.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const start = sorted[0].at.getTime();
  const span = Math.max(sorted.at(-1).at.getTime() - start, 1);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (point) => PAD.left + ((point.at.getTime() - start) / span) * plotWidth;
  const y = (value) => PAD.top + (1 - (value - min) / (max - min)) * plotHeight;

  const line = sorted.map((point, i) => `${i ? 'L' : 'M'}${x(point).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(sorted.at(-1)).toFixed(1)},${PAD.top + plotHeight} L${PAD.left},${PAD.top + plotHeight} Z`;
  const gridLines = [0, 0.5, 1].map((t) => {
    const value = min + (max - min) * (1 - t);
    const gy = PAD.top + t * plotHeight;
    return `<line x1="${PAD.left}" y1="${gy}" x2="${WIDTH - PAD.right}" y2="${gy}" stroke="#3f4147" stroke-width="1"/>`
      + `<text x="${PAD.left - 10}" y="${gy + 6}" text-anchor="end" font-family="${FONT}" font-size="17" fill="#b5bac1">${formatCompact(value)}</text>`;
  }).join('');
  const last = sorted.at(-1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1c40f" stop-opacity="0.35"/><stop offset="1" stop-color="#f1c40f" stop-opacity="0"/></linearGradient></defs>
    <rect width="${WIDTH}" height="${HEIGHT}" rx="12" fill="#2b2d31"/>
    <text x="${PAD.left}" y="30" font-family="${FONT}" font-size="20" fill="#f2f3f5">${escapeXml(title)}</text>
    ${gridLines}
    <path d="${area}" fill="url(#fill)"/>
    <path d="${line}" fill="none" stroke="#f1c40f" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="${x(last).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="5" fill="#f1c40f"/>
    <text x="${PAD.left}" y="${HEIGHT - 12}" font-family="${FONT}" font-size="16" fill="#b5bac1">${escapeXml(formatDate(sorted[0].at))}</text>
    <text x="${WIDTH - PAD.right}" y="${HEIGHT - 12}" text-anchor="end" font-family="${FONT}" font-size="16" fill="#b5bac1">${escapeXml(formatDate(last.at))}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
