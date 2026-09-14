import { EmbedBuilder } from 'discord.js';

export async function fetchMarketPrice(config, item) {
  if (config.demoMode) {
    const prices = {
      'demo-foregrip': 4_550,
      'demo-ammo': 47_016,
      'demo-kit': 9_069,
      'demo-vest': 25_944,
    };
    return {
      item,
      price: prices[item.id] ?? 0,
      referencePrice: 0,
      durabilityRatio: null,
      createdAt: new Date().toISOString(),
    };
  }
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
  };
  if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;

  const response = await fetch(`${config.apiBaseUrl}/deltaforceapi.gateway.ApiService/GetItemAuctionPrice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ itemId: item.id }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DeltaForce API responded with HTTP ${response.status}.`);
  const data = await response.json();
  return { ...data.price, item };
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

export function makeDemoWorkshopEmbed() {
  const recommendations = [
    { workshop: 'Cyber Warfare Division', item: 'Phantom Vertical Foregrip', sale: 18_200, materials: 13_650, minutes: 60 },
    { workshop: 'Workbench', item: '4.6×30mm AP SX', sale: 96_400, materials: 49_384, minutes: 60 },
    { workshop: 'Pharmacy', item: 'Precision Helmet Repair Kit', sale: 21_800, materials: 12_731, minutes: 60 },
    { workshop: 'Armor Bench', item: 'Elite Vest', sale: 68_700, materials: 42_756, minutes: 60 },
  ];

  const fields = recommendations.map(({ workshop, item, sale, materials, minutes }) => {
    const profit = sale - materials;
    const profitPerHour = Math.floor((profit / minutes) * 60);
    const roi = Math.round((profit / materials) * 100);
    return {
      name: `🏭 ${workshop}`,
      value: [
        `**${item}**`,
        `┌ ขายได้ \`${formatPrice(sale)}\`  •  ต้นทุน \`${formatPrice(materials)}\``,
        `└ **กำไร \`${formatPrice(profit)}\` / รอบ**  •  **🟢 \`${formatPrice(profitPerHour)}\` / ชม.**  •  ROI ${roi}%`,
      ].join('\n'),
      inline: false,
    };
  });

  return new EmbedBuilder()
    .setColor(0x18a558)
    .setTitle('Black Site Workshop — คำแนะนำการคราฟ')
    .setDescription('เลือกคราฟต์ที่ให้กำไรต่อชั่วโมงสูงสุดในแต่ละแผนก\n`กำไร = ราคาขาย − ต้นทุนวัตถุดิบ`')
    .addFields(fields)
    .setFooter({ text: 'ข้อมูลตัวอย่างสำหรับทดสอบ' })
    .setTimestamp();
}

export function makeMarketEmbed(prices) {
  const lines = prices.map(({ item, price, referencePrice, durabilityRatio, createdAt }) => {
    const reference = referencePrice ? ` · อ้างอิง ${formatPrice(referencePrice)}` : '';
    const durability = durabilityRatio == null ? '' : ` · ความทนทาน ${durabilityRatio}%`;
    const timestamp = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : null;
    return `**${item.name}**\nราคา: \`${formatPrice(price)}\`${reference}${durability}${timestamp ? `\nอัปเดต: <t:${timestamp}:R>` : ''}`;
  });
  return new EmbedBuilder()
    .setColor(0x18a558)
    .setTitle('Delta Force — ราคาตลาด')
    .setDescription(lines.join('\n\n').slice(0, 4_000))
    .setFooter({ text: prices.some(({ item }) => item.id.startsWith('demo-')) ? 'ข้อมูลตัวอย่างสำหรับทดสอบ' : 'ข้อมูลจาก deltaforceapi.com' })
    .setTimestamp();
}
