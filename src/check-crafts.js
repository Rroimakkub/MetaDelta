import { getConfig } from './config.js';
import { getCraftRecommendations } from './crafting.js';
import { calculateCraft } from './deltaforce.js';

const config = { ...getConfig(), demoMode: false };
const { groups, skipped } = await getCraftRecommendations(config);

console.table(groups.flatMap(({ crafts }) => crafts).map((craft) => {
  const { profit, profitPerHour, roi } = calculateCraft(craft);
  return {
    workshop: craft.workshop,
    item: craft.tier ? `${craft.item} T${craft.tier}` : craft.item,
    sale: craft.sale,
    materials: craft.materials,
    profit,
    perHour: profitPerHour,
    roi: roi == null ? '' : `${roi}%`,
  };
}));

for (const { recipe, reasons } of skipped) {
  console.log(`Skipped ${recipe.workshop} / ${recipe.item}:`);
  for (const reason of reasons) console.log(`  - ${reason}`);
}
