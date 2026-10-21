import sharp from 'sharp';

const WIDTH = 800;
const HEIGHT = 300;
const PAD = { top: 48, right: 24, bottom: 40, left: 84 };
// Font list for every image the bot draws. Segoe UI and Leelawadee UI (Thai) come with Windows; on a Linux server
// install Noto fonts (Ubuntu: fonts-noto-core) so Thai text doesn't render as boxes.
export const FONT = 'Segoe UI, Leelawadee UI, Noto Sans, Noto Sans Thai, Tahoma, sans-serif';

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

export const formatNumber = (value) => new Intl.NumberFormat('en-US').format(Math.round(value));

export function formatCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

// "21 ต.ค." (or "21" with month: false) in the given time zone.
export const formatDate = (date, timeZone = 'Asia/Bangkok', { month = true } = {}) => date.toLocaleDateString('th-TH', { day: 'numeric', ...(month && { month: 'short' }), timeZone });

// The same arrows and signs wherever a change is shown: "▲ +5.0%", "▼ −23.3%", "± 0.0%".
const arrow = (value) => (value > 0 ? '▲ +' : value < 0 ? '▼ −' : '± ');
export const formatPercentChange = (ratio) => `${arrow(ratio)}${Math.abs(ratio * 100).toFixed(1)}%`;
// "▲ +5.01M  (+3.0%)" against `base`; no change at all is just "± 0".
export function formatAmountChange(change, base) {
  if (!change) return '± 0';
  const percent = base ? `  (${change > 0 ? '+' : '−'}${Math.abs((change / base) * 100).toFixed(1)}%)` : '';
  return `${arrow(change)}${formatCompact(Math.abs(change))}${percent}`;
}

// Draws a line chart of { at: Date, value: number } points as a PNG. Returns null with fewer than 2 points.
// Optional: `start`/`end` fix the time axis (otherwise it spans the points), `badge` ({ text, color }) is shown top
// right, and `step` holds each value until the next point instead of drawing a slope (for values that change in
// jumps, like a stash). `days` ([{ start, end, label, today }]) splits the axis into days: alternate days are shaded,
// a dashed line marks each midnight, each label sits under its own day and today stands out; without it the first
// and last dates are labelled (in `timeZone`). `markers` ([{ at, value, label, color, below }]) rings chosen points
// and writes a short label above them (below with `below`), and `labelExtremes` tags the highest and lowest gridlines.
export async function makeLineChart(points, {
  title, start: rangeStart, end: rangeEnd, days, badge, step = false, timeZone, markers = [], labelExtremes = false,
}) {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const values = sorted.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  let min = low;
  let max = high;
  if (min === max) { min -= 1; max += 1; }
  // A little headroom so the line doesn't sit on the top or bottom edge; the axis labels stay at the real values.
  const headroom = (max - min) * 0.08;
  min -= headroom;
  max += headroom;
  const start = (rangeStart ?? sorted[0].at).getTime();
  const span = Math.max((rangeEnd ?? sorted.at(-1).at).getTime() - start, 1);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const xAt = (date) => PAD.left + ((date.getTime() - start) / span) * plotWidth;
  const x = (point) => xAt(point.at);
  const y = (value) => PAD.top + (1 - (value - min) / (max - min)) * plotHeight;

  const line = sorted.map((point, i) => {
    if (!i) return `M${x(point).toFixed(1)},${y(point.value).toFixed(1)}`;
    return step ? `H${x(point).toFixed(1)} V${y(point.value).toFixed(1)}` : `L${x(point).toFixed(1)},${y(point.value).toFixed(1)}`;
  }).join(' ');
  const area = `${line} L${x(sorted.at(-1)).toFixed(1)},${PAD.top + plotHeight} L${x(sorted[0]).toFixed(1)},${PAD.top + plotHeight} Z`;
  const levels = low === high ? [low] : [high, (low + high) / 2, low];
  const gridLines = levels.map((value) => {
    const gy = y(value);
    return `<line x1="${PAD.left}" y1="${gy}" x2="${WIDTH - PAD.right}" y2="${gy}" stroke="#3f4147" stroke-width="1"/>`
      + `<text x="${PAD.left - 10}" y="${gy + 6}" text-anchor="end" font-family="${FONT}" font-size="17" fill="#b5bac1">${formatCompact(value)}</text>`;
  }).join('');
  const last = sorted.at(-1);
  const dayBands = (days ?? []).map((day, index) => {
    const x1 = xAt(day.start);
    const width = xAt(day.end) - x1;
    const shade = day.today ? 'fill="#f1c40f" fill-opacity="0.08"' : index % 2 ? 'fill="#ffffff" fill-opacity="0.035"' : '';
    return (shade ? `<rect x="${x1.toFixed(1)}" y="${PAD.top - 8}" width="${width.toFixed(1)}" height="${HEIGHT - PAD.top + 4}" ${shade}/>` : '')
      + (index ? `<line x1="${x1.toFixed(1)}" y1="${PAD.top - 8}" x2="${x1.toFixed(1)}" y2="${PAD.top + plotHeight}" stroke="#4e5058" stroke-width="1" stroke-dasharray="4 4"/>` : '');
  }).join('');
  const axisLabels = days
    ? days.map((day) => {
      const center = (xAt(day.start) + xAt(day.end)) / 2;
      const style = day.today ? 'font-weight="bold" fill="#f2f3f5"' : 'fill="#b5bac1"';
      return `<text x="${center.toFixed(1)}" y="${HEIGHT - 12}" text-anchor="middle" font-family="${FONT}" font-size="16" ${style}>${escapeXml(day.label)}</text>`;
    }).join('')
    : `<text x="${PAD.left}" y="${HEIGHT - 12}" font-family="${FONT}" font-size="16" fill="#b5bac1">${escapeXml(formatDate(sorted[0].at, timeZone))}</text>`
      + `<text x="${WIDTH - PAD.right}" y="${HEIGHT - 12}" text-anchor="end" font-family="${FONT}" font-size="16" fill="#b5bac1">${escapeXml(formatDate(last.at, timeZone))}</text>`;
  const badgeText = badge
    ? `<text x="${WIDTH - PAD.right}" y="30" text-anchor="end" font-family="${FONT}" font-size="20" font-weight="bold" fill="${badge.color}">${escapeXml(badge.text)}</text>`
    : '';
  const extremeTags = labelExtremes && low !== high
    ? `<text x="${WIDTH - PAD.right - 4}" y="${(y(high) - 6).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="13" fill="#80848e">สูงสุด</text>`
      + `<text x="${WIDTH - PAD.right - 4}" y="${(y(low) + 16).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="13" fill="#80848e">ต่ำสุด</text>`
    : '';
  // A label goes on its preferred side unless that side has no room or would crowd the previous label there. A label
  // moved to the other side shifts right so it doesn't sit on the step's vertical line.
  const lastLabelX = { above: -Infinity, below: -Infinity };
  const other = (side) => (side === 'above' ? 'below' : 'above');
  const markerShapes = [...markers].sort((a, b) => a.at - b.at).map((marker) => {
    const mx = xAt(marker.at);
    const my = y(marker.value);
    const fits = (side) => (side === 'above' ? my - 10 >= PAD.top + 14 : my + 20 <= PAD.top + plotHeight - 2);
    const preferred = marker.below ? 'below' : 'above';
    const side = fits(preferred) && mx - lastLabelX[preferred] >= 56 ? preferred : other(preferred);
    lastLabelX[side] = mx;
    const labelX = Math.min(Math.max(mx + (side === preferred ? 0 : 34), PAD.left + 28), WIDTH - PAD.right - 28);
    const labelY = Math.min(Math.max(side === 'above' ? my - 10 : my + 20, PAD.top + 12), PAD.top + plotHeight - 4);
    return `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4" fill="#2b2d31" stroke="#f1c40f" stroke-width="2.5"/>`
      + (marker.label ? `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="bold" fill="${marker.color ?? '#f2f3f5'}">${escapeXml(marker.label)}</text>` : '');
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1c40f" stop-opacity="0.35"/><stop offset="1" stop-color="#f1c40f" stop-opacity="0"/></linearGradient></defs>
    <rect width="${WIDTH}" height="${HEIGHT}" rx="12" fill="#2b2d31"/>
    ${dayBands}
    <text x="${PAD.left}" y="30" font-family="${FONT}" font-size="20" fill="#f2f3f5">${escapeXml(title)}</text>
    ${badgeText}
    ${gridLines}
    <path d="${area}" fill="url(#fill)"/>
    <path d="${line}" fill="none" stroke="#f1c40f" stroke-width="3" stroke-linejoin="round"/>
    ${extremeTags}
    ${markerShapes}
    <circle cx="${x(last).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="5" fill="#f1c40f"/>
    ${axisLabels}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
