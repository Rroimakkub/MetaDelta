import { Client, Events, GatewayIntentBits } from 'discord.js';
import { getConfig } from './config.js';
import { getCraftRecommendations } from './crafting.js';
import { fetchMarketPrice, makeDemoWorkshopEmbed, makeMarketEmbed, makeWorkshopEmbed } from './deltaforce.js';
import { getAllChannels, getChannel, setChannel } from './store.js';

const config = getConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postToChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Configured channel is unavailable or is not a text channel.');
  if (config.demoMode) {
    await channel.send({ embeds: [makeDemoWorkshopEmbed()] });
    return;
  }
  const embeds = [await makeCraftEmbed()];
  if (config.marketItems.length) {
    const results = await Promise.allSettled(config.marketItems.map((item) => fetchMarketPrice(config, item)));
    const prices = results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
    if (prices.length) embeds.push(makeMarketEmbed(prices));
  }
  await channel.send({ embeds });
}

async function makeCraftEmbed() {
  const { groups, skipped } = await getCraftRecommendations(config);
  for (const { recipe, reasons } of skipped) console.warn(`Skipped recipe ${recipe.item}: ${reasons.join('; ')}`);
  if (!groups.length) throw new Error('Could not price any recipe in data/recipes.json.');
  const notes = skipped.length ? [`⚠️ ข้าม ${skipped.length} สูตรเพราะดึงราคาไม่ได้`] : [];
  return makeWorkshopEmbed(groups, { footer: 'ราคาจาก deltaforceapi.com', notes });
}

async function postToAllConfiguredChannels() {
  for (const { guildId, channelId } of await getAllChannels()) {
    try {
      await postToChannel(channelId);
    } catch (error) {
      console.error(`Could not post to guild ${guildId}:`, error.message);
    }
  }
}

let lastPostedOn = null;

async function checkSchedule() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts();
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}`;
  if (time === config.postTime && lastPostedOn !== date) {
    lastPostedOn = date;
    await postToAllConfiguredChannels();
  }
}

function scheduleDailyPost() {
  console.log(`Automatic post scheduled for ${config.postTime} (${config.timeZone}).`);
  checkSchedule().catch((error) => console.error('Schedule check failed:', error.message));
  setInterval(() => checkSchedule().catch((error) => console.error('Schedule check failed:', error.message)), 30_000);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  scheduleDailyPost();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    if (interaction.commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased()) return interaction.reply({ content: 'กรุณาเลือกห้องข้อความ', ephemeral: true });
      await setChannel(interaction.guildId, channel.id);
      return interaction.reply({ content: `ตั้งค่าการโพสต์ราคาตลาดอัตโนมัติที่ ${channel} แล้ว`, ephemeral: true });
    }
    if (interaction.commandName === 'botstatus') {
      const channelId = await getChannel(interaction.guildId);
      return interaction.reply({ content: channelId ? `ห้องปัจจุบัน: <#${channelId}>\nเวลาโพสต์: ${config.postTime} (${config.timeZone})` : 'ยังไม่ได้ตั้งห้อง ใช้ /setchannel ก่อน', ephemeral: true });
    }
    if (interaction.commandName === 'postnow') {
      await interaction.deferReply({ ephemeral: true });
      const channelId = await getChannel(interaction.guildId);
      if (!channelId) return interaction.editReply('ยังไม่ได้ตั้งห้อง ใช้ /setchannel ก่อน');
      await postToChannel(channelId);
      return interaction.editReply(`โพสต์ราคาตลาดไปที่ <#${channelId}> แล้ว`);
    }
  } catch (error) {
    console.error(error);
    const response = 'โพสต์ไม่สำเร็จ กรุณาตรวจสอบ API endpoint, API token และสิทธิ์ของบอตในห้องนั้น';
    if (interaction.deferred || interaction.replied) await interaction.editReply(response);
    else await interaction.reply({ content: response, ephemeral: true });
  }
});

client.login(config.botToken);
