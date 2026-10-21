// Calendar parts of `date` as seen in `timeZone`, as numbers (weekday: 0 = Monday ... 6 = Sunday).
export function zonedParts(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday),
  };
}

// How far `timeZone` is ahead of UTC at `date`, in ms.
function offsetAt(timeZone, date) {
  const p = zonedParts(timeZone, date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// Midnight at the start of a calendar day in `timeZone`; out-of-range days roll over (day 0, day 32, ...).
// The offset is checked at that day rather than now, so weeks that cross a daylight-saving change still start
// at local midnight.
export function startOfDay(timeZone, year, month, day) {
  const wallClock = Date.UTC(year, month - 1, day);
  const guess = wallClock - offsetAt(timeZone, new Date(wallClock));
  return new Date(wallClock - offsetAt(timeZone, new Date(guess)));
}

// The current week in `timeZone`: Monday 00:00 up to the next Monday 00:00, and the start of each of its 7 days.
export function currentWeek(timeZone, now = new Date()) {
  const today = zonedParts(timeZone, now);
  const starts = Array.from({ length: 8 }, (_, index) => startOfDay(timeZone, today.year, today.month, today.day - today.weekday + index));
  return { start: starts[0], end: starts[7], days: starts.slice(0, 7), timeZone };
}
