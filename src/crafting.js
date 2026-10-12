import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateCraft, fetchMarketPrice, findItem, normalizeName } from './deltaforce.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/recipes.json');

const refKey = (ref) => `${normalizeName(ref.item)}|${ref.quality ?? ''}`;

function checkRef(ref, where) {
  if (!ref || typeof ref.item !== 'string' || !ref.item.trim()) throw new Error(`${where}: "item" must be an English item name.`);
  if (ref.price != null && !(Number.isFinite(ref.price) && ref.price >= 0)) throw new Error(`${where}: "price" must be a number.`);
  if (ref.quantity != null && !(Number.isFinite(ref.quantity) && ref.quantity > 0)) throw new Error(`${where}: "quantity" must be above 0.`);
  if (ref.quality != null && !Number.isInteger(ref.quality)) throw new Error(`${where}: "quality" must be a whole number.`);
}

function checkMaterials(materials, where) {
  if (!Array.isArray(materials) || !materials.length) throw new Error(`${where}: "materials" must be a non-empty list.`);
  materials.forEach((material, i) => checkRef(material, `${where}, material #${i + 1}`));
}

export async function loadRecipes() {
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing data/recipes.json. Copy data/recipes.example.json and enter real recipes.');
    throw new Error(`data/recipes.json is not valid JSON: ${error.message}`);
  }
  const recipes = data.recipes ?? [];
  const intermediates = data.intermediates ?? [];
  if (!Array.isArray(recipes) || !recipes.length) throw new Error('data/recipes.json must contain a non-empty "recipes" list.');
  recipes.forEach((recipe, index) => {
    const where = `Recipe #${index + 1} (${recipe.item ?? '?'})`;
    if (typeof recipe.workshop !== 'string' || !recipe.workshop.trim()) throw new Error(`${where}: "workshop" is required.`);
    if (!(Number.isFinite(recipe.minutes) && recipe.minutes > 0)) throw new Error(`${where}: "minutes" must be above 0.`);
    checkRef(recipe, where);
    checkMaterials(recipe.materials, where);
  });
  intermediates.forEach((intermediate, index) => {
    const where = `Intermediate #${index + 1} (${intermediate.item ?? '?'})`;
    checkRef(intermediate, where);
    checkMaterials(intermediate.materials, where);
  });
  return { recipes, intermediates: new Map(intermediates.map((intermediate) => [refKey(intermediate), intermediate])) };
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

// Looks up every item that needs a market price. Intermediates are priced from their own materials instead.
async function fetchPrices(config, recipes, intermediates) {
  const refs = [
    ...recipes.flatMap((recipe) => [recipe, ...recipe.materials]),
    ...[...intermediates.values()].flatMap((intermediate) => intermediate.materials),
  ].filter((ref) => ref.price == null && !intermediates.has(refKey(ref)));
  const unique = [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
  const results = await mapLimit(unique, 4, async (ref) => {
    const item = ref.id ? { id: ref.id, name: ref.item } : await findItem(config, ref.item, ref.quality);
    const { price } = await fetchMarketPrice(config, item);
    return { price, name: item.name, icon: item.iconUrl };
  });
  const found = new Map();
  const errors = new Map();
  unique.forEach((ref, index) => {
    if (results[index].status === 'fulfilled') found.set(refKey(ref), results[index].value);
    else errors.set(refKey(ref), results[index].reason.message);
  });
  return { found, errors };
}

export async function getCraftRecommendations(config) {
  const { recipes, intermediates } = await loadRecipes();
  const { found, errors } = await fetchPrices(config, recipes, intermediates);
  const keep = 1 - config.sellTaxPercent / 100;

  // Returns the unit price of a ref, or a list of reasons it could not be priced.
  function unitPrice(ref) {
    if (ref.price != null) return { price: ref.price };
    const intermediate = intermediates.get(refKey(ref));
    if (intermediate) {
      const parts = intermediate.materials.map(unitPrice);
      const missing = parts.flatMap((part) => part.missing ?? []);
      if (missing.length) return { missing };
      const total = parts.reduce((sum, part, i) => sum + part.price * (intermediate.materials[i].quantity ?? 1), 0);
      return { price: total / (intermediate.quantity ?? 1) };
    }
    const hit = found.get(refKey(ref));
    return hit ? { price: hit.price } : { missing: [`${ref.item}: ${errors.get(refKey(ref)) ?? 'no price'}`] };
  }

  const crafts = [];
  const skipped = [];
  for (const recipe of recipes) {
    const output = unitPrice(recipe);
    const inputs = recipe.materials.map(unitPrice);
    const missing = [output, ...inputs].flatMap((part) => part.missing ?? []);
    if (missing.length) {
      skipped.push({ recipe, reasons: missing });
      continue;
    }
    const quantity = recipe.quantity ?? 1;
    const materials = inputs.reduce((sum, part, i) => sum + part.price * (recipe.materials[i].quantity ?? 1), 0);
    crafts.push({
      workshop: recipe.workshop,
      item: found.get(refKey(recipe))?.name ?? recipe.item,
      icon: found.get(refKey(recipe))?.icon,
      tier: recipe.quality,
      quantity,
      sale: Math.floor(output.price * quantity * keep),
      materials: Math.round(materials),
      minutes: recipe.minutes,
    });
  }

  const workshops = new Map();
  for (const craft of crafts) {
    if (!workshops.has(craft.workshop)) workshops.set(craft.workshop, []);
    workshops.get(craft.workshop).push(craft);
  }
  const groups = [...workshops].map(([workshop, list]) => ({
    workshop,
    crafts: list.sort((a, b) => calculateCraft(b).profitPerHour - calculateCraft(a).profitPerHour),
  }));
  return { groups, skipped };
}
