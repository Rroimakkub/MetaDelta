import 'dotenv/config';

const query = process.argv.slice(2).join(' ').trim().toLocaleLowerCase();
if (!query) {
  console.error('Usage: npm run find-items -- <part of an item name>');
  process.exit(1);
}

const baseUrl = (process.env.DELTAFORCE_API_BASE_URL ?? 'https://api.deltaforceapi.com').replace(/\/$/, '');
const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'Connect-Protocol-Version': '1',
};
if (process.env.DELTAFORCE_API_TOKEN) headers.Authorization = `Bearer ${process.env.DELTAFORCE_API_TOKEN}`;

const response = await fetch(`${baseUrl}/deltaforceapi.gateway.ApiService/ListItems`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ pageSize: 100, language: 'LANGUAGE_EN' }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`DeltaForce API responded with HTTP ${response.status}.`);

const { items = [] } = await response.json();
const matches = items.filter((item) => `${item.name} ${item.shortName ?? ''}`.toLocaleLowerCase().includes(query));
if (!matches.length) {
  console.log('No match in the first 100 items. Try a different English search word.');
} else {
  for (const item of matches) console.log(`${item.id}|${item.name}`);
}
