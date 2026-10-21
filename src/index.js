import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { commands } from './commands.js';
import { getConfig } from './config.js';
import { craftKey, getCachedCraftRecommendations, loadRecipes } from './crafting.js';
import {
  attachThumbnails, fetchMarketPrice, getCatalog, makeCraftDetailMessage, makeDemoWorkshopMessages, makeMarketEmbed, makeWorkshopGridMessage, makeWorkshopMessages,
  normalizeName, topCrafts, workshopCells,
} from './deltaforce.js';
import { fetchPriceSeries, getRedBoard, makePriceMessage, makeRedBoardMessage, resolveMarketItem, suggestMarketItems } from './market.js';
import { makeWorkshopGrid } from './workshop-grid.js';
import { fetchPlayerReport, LIFETIME, listSeasons, makePlayerMessage, PlayerNotFoundError, seasonLabel } from './player.js';
import { cooldownLeft, cooldownReply, refundCooldown } from './permissions.js';
import { makeMaterialsImage } from './recipe-card.js';
import { getAllChannels, getChannel, setChannel } from './store.js';
import { zonedParts } from './time.js';

const config = getConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// The daily post: craft recommendations, the red loot board, then any MARKET_ITEMS prices. Built once and sent to
// every market channel; thumbnails are downloaded here so the same files can be reused for each channel.
async function makeDailyMessages() {
  // Pricing the recipes and the red loot board don't depend on each other, so both run at once.
  const [messages, board] = await Promise.all([
    config.demoMode ? makeDemoWorkshopMessages() : makeCraftMessages(),
    config.demoMode ? [] : getRedBoard(config).catch((error) => {
      console.warn('Could not build the red loot board:', error.message);
      return [];
    }),
  ]);
  if (board.length) messages.push(makeRedBoardMessage(board));
  if (!config.demoMode && config.marketItems.length) {
    const results = await Promise.allSettled(config.marketItems.map((item) => fetchMarketPrice(config, item)));
    const prices = results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
    if (prices.length) messages.push({ embeds: [makeMarketEmbed(prices)] });
  }
  return Promise.all(messages.map(attachThumbnails));
}

async function postToChannel(channelId, messages) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Configured channel is unavailable or is not a text channel.');
  for (const message of messages) await channel.send(message);
}

async function makeCraftMessages() {
  const { groups, skipped } = await getCachedCraftRecommendations(config, { fresh: true });
  for (const { recipe, reasons } of skipped) console.warn(`Skipped recipe ${recipe.item}: ${reasons.join('; ')}`);
  if (!groups.length) throw new Error('Could not price any recipe in data/recipes.json.');
  const notes = skipped.length ? [`⚠️ ข้าม ${skipped.length} สูตรเพราะดึงราคาไม่ได้`] : [];
  // One craft per workshop: all four workshops in a single 2×2 grid image.
  if (config.topPerWorkshop === 1) {
    const cells = workshopCells(groups);
    const image = await makeWorkshopGrid(cells).catch((error) => {
      console.warn('Could not draw the workshop grid:', error.message);
      return null;
    });
    return [makeWorkshopGridMessage(cells, { footer: 'ราคาจาก deltaforceapi.com', notes, image })];
  }
  const shown = topCrafts(groups, config.topPerWorkshop);
  for (const craft of shown.flatMap(({ crafts }) => crafts)) {
    craft.materialsImage = await makeMaterialsImage(craft.materialList, craft.materials).catch((error) => {
      console.warn(`Could not draw materials for ${craft.item}:`, error.message);
      return null;
    });
  }
  return makeWorkshopMessages(shown, { footer: 'ราคาจาก deltaforceapi.com', notes, top: config.topPerWorkshop });
}

async function postToAllConfiguredChannels() {
  const channels = await getAllChannels('market');
  if (!channels.length) return;
  const messages = await makeDailyMessages();
  for (const { guildId, channelId } of channels) {
    try {
      await postToChannel(channelId, messages);
    } catch (error) {
      console.error(`Could not post to guild ${guildId}:`, error.message);
    }
  }
}

let lastPostedOn = null;

async function checkSchedule() {
  const now = zonedParts(config.timeZone);
  const pad = (number) => String(number).padStart(2, '0');
  const date = `${now.year}-${pad(now.month)}-${pad(now.day)}`;
  const time = `${pad(now.hour)}:${pad(now.minute)}`;
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

// Keeps each server's slash commands in sync with src/commands.js, so moving or inviting the bot
// needs no manual `npm run register`.
async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} commands in ${guild.name}.`);
  } catch (error) {
    console.error(`Could not register commands in ${guild.name}:`, error.message);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  for (const guild of readyClient.guilds.cache.values()) await registerCommands(guild);
  scheduleDailyPost();
  // Load the item list now so /price autocomplete has names to suggest from the first keystroke.
  if (!config.demoMode) getCatalog(config).catch((error) => console.warn('Could not load the item list:', error.message));
});

client.on(Events.GuildCreate, (guild) => registerCommands(guild));

// Permissions the bot needs to post its cards (embeds with attached images) in a channel.
const POST_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'];

// Private channels and category overrides can hide a channel from the bot even when its role allows posting.
function missingPostPermissions(guild, channelId) {
  const permissions = guild?.channels.cache.get(channelId)?.permissionsFor(guild.members.me);
  return permissions ? POST_PERMISSIONS.filter((flag) => !permissions.has(PermissionFlagsBits[flag])) : [];
}

// Recipe names come straight from data/recipes.json so autocomplete answers within Discord's 3-second limit.
async function suggestCrafts(interaction) {
  const typed = normalizeName(interaction.options.getFocused());
  const { recipes } = await loadRecipes();
  await interaction.respond(recipes
    .map((recipe) => ({ name: `${recipe.item}${recipe.quality ? ` T${recipe.quality}` : ''} · ${recipe.workshop}`.slice(0, 100), value: craftKey(recipe) }))
    .filter((choice) => normalizeName(choice.name).includes(typed))
    .slice(0, 25));
}

// Finds a craft by its autocomplete key, or by name when the user typed text without picking a suggestion.
function findCraft(groups, query) {
  const all = groups.flatMap(({ crafts }) => crafts);
  const byKey = all.find((craft) => craft.key === query);
  if (byKey) return byKey;
  const typed = normalizeName(query);
  return all.find((craft) => normalizeName(craft.item) === typed) ?? all.find((craft) => normalizeName(craft.item).includes(typed)) ?? null;
}

async function suggestPrices(interaction) {
  await interaction.respond(suggestMarketItems(config, interaction.options.getFocused()));
}

async function suggestSeasons(interaction) {
  const typed = interaction.options.getFocused().toLocaleLowerCase();
  const seasons = config.demoMode ? [] : await listSeasons(config).catch(() => []);
  const choices = [
    ...seasons.map((season) => ({ name: seasonLabel(season), value: season.id })),
    { name: 'ตลอดกาล', value: LIFETIME },
  ].filter((choice) => choice.name.toLocaleLowerCase().includes(typed));
  await interaction.respond(choices.slice(0, 25));
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const suggest ={ player: suggestSeasons, craft: suggestCrafts, price: suggestPrices }[interaction.commandName];
    return suggest?.(interaction).catch((error) => console.error('Autocomplete failed:', error.message));
  }
  // Older /player cards still carry the removed Overview / Recent matches buttons; clicking one just removes them.
  if (interaction.isButton() && interaction.customId.startsWith('player|')) {
    return interaction.update({ components: [] });
  }
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    if (interaction.commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel', true);
      const kind = interaction.options.getString('type') ?? 'market';
      if (!channel.isTextBased()) return interaction.reply({ content: 'กรุณาเลือกห้องข้อความ', flags: MessageFlags.Ephemeral });
      await setChannel(interaction.guildId, channel.id, kind);
      const what = kind === 'stats' ? 'ห้องสถิติผู้เล่น (ผลของ /player จะส่งมาที่นี่)' : 'ห้องตลาด (คำแนะนำคราฟรายวันและ /craftpost)';
      const missing = missingPostPermissions(interaction.guild, channel.id);
      const warning = missing.length
        ? `\n⚠️ แต่บอตยังโพสต์ในห้องนี้ไม่ได้ ขาดสิทธิ์: **${missing.join(', ')}**\nแก้ที่ ตั้งค่าห้อง → Permissions → เพิ่ม role **${interaction.guild.members.me.roles.botRole?.name ?? interaction.client.user.username}** แล้วอนุญาตสิทธิ์ข้างบน`
        : '';
      return interaction.reply({ content: `ตั้ง ${channel} เป็น${what}แล้ว${warning}`, flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === 'botstatus') {
      const [market, stats] = await Promise.all([getChannel(interaction.guildId, 'market'), getChannel(interaction.guildId, 'stats')]);
      const channelStatus = (channelId) => {
        const missing = missingPostPermissions(interaction.guild, channelId);
        return `<#${channelId}>${missing.length ? `  ⚠️ บอตขาดสิทธิ์ ${missing.join(', ')} ในห้องนี้` : ''}`;
      };
      return interaction.reply({
        content: [
          `ห้องตลาด: ${market ? channelStatus(market) : 'ยังไม่ได้ตั้ง (ใช้ /setchannel type:ตลาด)'}`,
          `ห้องสถิติ: ${stats ? channelStatus(stats) : 'ยังไม่ได้ตั้ง (ผล /player จะขึ้นในห้องที่พิมพ์)'}`,
          `Cooldown ของ /player, /craft และ /price: ${config.commandCooldownSeconds ? `${config.commandCooldownSeconds} วินาทีต่อคน (แอดมินไม่ติด)` : 'ปิด'}`,
          `เวลาโพสต์: ${config.postTime} (${config.timeZone})`,
        ].join('\n'),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }
    if (interaction.commandName === 'craftpost') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channelId = await getChannel(interaction.guildId);
      if (!channelId) return interaction.editReply('ยังไม่ได้ตั้งห้อง ใช้ /setchannel ก่อน');
      // Check access first: building the post takes ~300 API calls.
      const missing = missingPostPermissions(interaction.guild, channelId);
      if (missing.length) return interaction.editReply(`บอตโพสต์ใน <#${channelId}> ไม่ได้ ขาดสิทธิ์: **${missing.join(', ')}** (ดูวิธีแก้ที่ /botstatus)`);
      await postToChannel(channelId, await makeDailyMessages());
      return interaction.editReply(`โพสต์ราคาตลาดไปที่ <#${channelId}> แล้ว`);
    }
    if (interaction.commandName === 'craft') {
      if (config.demoMode) return interaction.reply({ content: 'คำสั่งนี้ต้องใช้ข้อมูลจริงจาก API ตั้ง DEMO_MODE=false ก่อน', flags: MessageFlags.Ephemeral });
      const query = interaction.options.getString('item', true);
      const wait = cooldownLeft(interaction, config.commandCooldownSeconds);
      if (wait) return interaction.reply(cooldownReply(wait));
      await interaction.deferReply();
      const { groups, skipped } = await getCachedCraftRecommendations(config);
      const craft = findCraft(groups, query);
      if (!craft) {
        const failed = skipped.find(({ recipe }) => craftKey(recipe) === query);
        return interaction.editReply(failed ? `ดึงราคาของ **${failed.recipe.item}** ไม่ได้ตอนนี้ ลองใหม่ภายหลัง` : 'ไม่พบสูตรนี้ เลือกชื่อจากรายการที่ขึ้นตอนพิมพ์');
      }
      const workshopCrafts = groups.find((group) => group.workshop === craft.workshop).crafts;
      const image = await makeMaterialsImage(craft.materialList, craft.materials).catch(() => null);
      const message = makeCraftDetailMessage(craft, {
        rank: workshopCrafts.indexOf(craft) + 1, total: workshopCrafts.length, image, footer: 'ราคาจาก deltaforceapi.com (อัปเดตทุก 10 นาที)',
      });
      return interaction.editReply(await attachThumbnails(message));
    }
    if (interaction.commandName === 'price') {
      if (config.demoMode) return interaction.reply({ content: 'คำสั่งนี้ต้องใช้ข้อมูลจริงจาก API ตั้ง DEMO_MODE=false ก่อน', flags: MessageFlags.Ephemeral });
      const query = interaction.options.getString('item', true).trim();
      const wait = cooldownLeft(interaction, config.commandCooldownSeconds);
      if (wait) return interaction.reply(cooldownReply(wait));
      await interaction.deferReply();
      const item = await resolveMarketItem(config, query);
      if (!item) {
        refundCooldown(interaction);
        return interaction.editReply('ไม่พบไอเทมนี้ในตลาด เลือกชื่อจากรายการที่ขึ้นตอนพิมพ์ (ชื่อภาษาอังกฤษ)');
      }
      const [price, series] = await Promise.allSettled([
        fetchMarketPrice(config, { id: item.id, name: item.name }),
        fetchPriceSeries(config, item.id),
      ]);
      if (series.status === 'rejected') console.warn(`Could not load the price history of ${item.name}:`, series.reason.message);
      if (price.status === 'rejected') {
        refundCooldown(interaction);
        if (price.reason.status === 404) return interaction.editReply(`**${item.name}** ยังไม่มีราคาในตลาดตอนนี้`);
        console.error(`Could not load the price of ${item.name}:`, price.reason.message);
        return interaction.editReply('ดึงราคาไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง');
      }
      const message = await makePriceMessage(item, {
        price: price.value, series: series.status === 'fulfilled' ? series.value : [], sellTaxPercent: config.sellTaxPercent, timeZone: config.timeZone,
      });
      return interaction.editReply(await attachThumbnails(message));
    }
    if (interaction.commandName === 'player') {
      if (config.demoMode) return interaction.reply({ content: 'คำสั่งนี้ต้องใช้ข้อมูลจริงจาก API ตั้ง DEMO_MODE=false ก่อน', flags: MessageFlags.Ephemeral });
      const query = interaction.options.getString('name', true).trim();
      const seasonKey = interaction.options.getString('season') ?? 'current';
      const wait = cooldownLeft(interaction, config.commandCooldownSeconds);
      if (wait) return interaction.reply(cooldownReply(wait));
      // With a stats channel set, cards used elsewhere are posted there and the caller gets a private pointer.
      const statsChannelId = await getChannel(interaction.guildId, 'stats');
      const redirect = statsChannelId && statsChannelId !== interaction.channelId;
      await interaction.deferReply(redirect ? { flags: MessageFlags.Ephemeral } : {});
      try {
        const report = await fetchPlayerReport(config, query, { seasonId: seasonKey === 'current' ? undefined : seasonKey });
        const message = await makePlayerMessage(report);
        if (!redirect) return interaction.editReply(message);
        const channel = await client.channels.fetch(statsChannelId);
        if (!channel?.isTextBased()) throw new Error('Stats channel is unavailable.');
        await channel.send({ content: `${interaction.user} ค้นหาสถิติของ **${report.player.name}**`, allowedMentions: { parse: [] }, ...message });
        return interaction.editReply(`ส่งสถิติของ **${report.player.name}** ไปที่ <#${statsChannelId}> แล้ว`);
      } catch (error) {
        if (error instanceof PlayerNotFoundError) return interaction.editReply(`ไม่พบผู้เล่นชื่อ **${query}** ลองเช็กตัวสะกด หรือใช้ Delta Force ID แทน`);
        console.error(error);
        if ([50001, 50013].includes(error.code)) return interaction.editReply(`บอตไม่มีสิทธิ์โพสต์ใน <#${statsChannelId}> ให้แอดมินเพิ่มสิทธิ์ให้ role ของบอตในห้องนั้น (ดูได้ที่ /botstatus)`);
        return interaction.editReply('ดึงข้อมูลผู้เล่นไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง');
      }
    }
  } catch (error) {
    console.error(error);
    // 50001 Missing Access / 50013 Missing Permissions: the bot can't see or post in the configured channel.
    const response = [50001, 50013].includes(error.code)
      ? 'บอตไม่มีสิทธิ์โพสต์ในห้องที่ตั้งไว้ ดูว่าขาดสิทธิ์อะไรได้ที่ /botstatus แล้วเพิ่มสิทธิ์ให้ role ของบอตในตั้งค่าห้อง → Permissions'
      : 'โพสต์ไม่สำเร็จ กรุณาตรวจสอบ API endpoint, API token และสิทธิ์ของบอตในห้องนั้น';
    // The interaction itself may be what failed (e.g. answered after Discord's 3-second limit), so this reply can fail too.
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply(response)
      : interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
    await reply.catch((replyError) => console.error('Could not send the error reply:', replyError.message));
  }
});

// discord.js turns a rejected event handler into an 'error' event, and an 'error' event with no listener
// crashes the process. Log these instead so one failed reply doesn't restart the bot.
client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

// A failed login (e.g. no network yet after boot) exits so pm2 restarts the bot and tries again.
client.login(config.botToken).catch((error) => {
  console.error('Login failed:', error.message);
  process.exit(1);
});
