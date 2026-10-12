import 'dotenv/config';
import { listAllItems } from './deltaforce.js';

const query = process.argv.slice(2).join(' ').trim().toLocaleLowerCase();
if (!query) {
  console.error('Usage: npm run find-items -- <part of an item name>');
  process.exit(1);
}

const config = {
  apiToken: process.env.DELTAFORCE_API_TOKEN ?? '',
  apiBaseUrl: (process.env.DELTAFORCE_API_BASE_URL ?? 'https://api.deltaforceapi.com').replace(/\/$/, ''),
};

const matches = (await listAllItems(config)).filter((item) => `${item.name} ${item.shortName ?? ''}`.toLocaleLowerCase().includes(query));
if (!matches.length) {
  console.log('No match. Try a different English search word.');
} else {
  for (const item of matches) console.log(`${item.id}|${item.name}  (T${item.quality ?? '?'}${item.auctionable === false ? ', not on market' : ''})`);
}
