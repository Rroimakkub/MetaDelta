import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { commands } from './commands.js';
import { getConfig } from './config.js';
import { craftKey, getCachedCraftRecommendations, loadRecipes } from './crafting.js';
import {
  attachThumbnails, fetchMarketPrice, makeCraftDetailMessage, makeDemoWorkshopMessages, makeMarketEmbed, makeWorkshopGridMessage, makeWorkshopMessages,
  normalizeName, topCrafts, workshopCells,
} from './deltaforce.js';
import { makeWorkshopGrid } from './workshop-grid.js';
import {
  fetchPlayerReport, findPlayer, LIFETIME, listSeasons, makeMatchesMessage, makeMatchNotification, makePlayerMessage, playerButtons, PlayerNotFoundError, seasonLabel,
} from './player.js';
import { canManageTracking, cooldownLeft, cooldownReply } from './permissions.js';
import { makeMaterialsImage } from './recipe-card.js';
import { getAllChannels, getChannel, getGuildSetting, setChannel, setGuildSetting } from './store.js';
import { getTracking, listTracked, MAX_PLAYERS_PER_GUILD, pollTrackedPlayers, touchPlayer, trackPlayer, untrackPlayer } from './tracking.js';

const config = getConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postToChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Configured channel is unavailable or is not a text channel.');
  const messages = config.demoMode ? makeDemoWorkshopMessages() : await makeCraftMessages();
  if (!config.demoMode && config.marketItems.length) {
    const results = await Promise.allSettled(config.marketItems.map((item) => fetchMarketPrice(config, item)));
    const prices = results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
    if (prices.length) messages.push({ embeds: [makeMarketEmbed(prices)] });
  }
  for (const message of messages) await channel.send(await attachThumbnails(message));
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
  for (const { guildId, channelId } of await getAllChannels('market')) {
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

// Posts each new match in the stats channel of every server tracking that player.
// MATCH_NOTIFY=pinned (default) only announces players added with /track add, so players who were
// merely looked up with /player don't fill the channel.
async function announceMatches(newEvents) {
  if (config.matchNotify === 'off') return;
  for (const { name, pinned, guildIds, event } of newEvents) {
    if (config.matchNotify === 'pinned' && !pinned) continue;
    for (const guildId of guildIds) {
      const channelId = await getChannel(guildId, 'stats');
      if (!channelId) continue;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) await channel.send(makeMatchNotification(name, event));
      } catch (error) {
        console.warn(`Could not announce a match for ${name} in guild ${guildId}:`, error.message);
      }
    }
  }
}

function scheduleTracking() {
  if (config.demoMode) return;
  const run = () => pollTrackedPlayers(config)
    .then(async (newEvents) => {
      if (!newEvents.length) return;
      console.log(`Tracking: recorded ${newEvents.length} new match event(s).`);
      await announceMatches(newEvents);
    })
    .catch((error) => console.error('Tracking poll failed:', error.message));
  console.log(`Tracking players every ${config.trackIntervalMinutes} minutes.`);
  run();
  setInterval(run, config.trackIntervalMinutes * 60_000);
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
  scheduleTracking();
});

client.on(Events.GuildCreate, (guild) => registerCommands(guild));

// Builds either view of a /player card with its toggle buttons. seasonKey is a season id, LIFETIME or 'current'.
async function playerView(playerId, seasonKey, view) {
  let message;
  if (view === 'matches') {
    await touchPlayer(playerId);
    const player = await findPlayer(config, playerId);
    message = makeMatchesMessage(player.name, await getTracking(playerId), { intervalMinutes: config.trackIntervalMinutes });
  } else {
    message = await makePlayerMessage(await fetchPlayerReport(config, playerId, { seasonId: seasonKey === 'current' ? undefined : seasonKey }));
  }
  return { ...message, components: [playerButtons(playerId, seasonKey, view)] };
}

async function suggestTracked(interaction) {
  const typed = interaction.options.getFocused().toLocaleLowerCase();
  const players = await listTracked(interaction.guildId);
  await interaction.respond(players
    .filter((player) => player.name.toLocaleLowerCase().includes(typed))
    .slice(0, 25)
    .map((player) => ({ name: player.name, value: player.name })));
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
    const suggest = { player: suggestSeasons, track: suggestTracked, craft: suggestCrafts }[interaction.commandName];
    return suggest?.(interaction).catch((error) => console.error('Autocomplete failed:', error.message));
  }
  if (interaction.isButton() && interaction.customId.startsWith('player|')) {
    const [, view, playerId, seasonKey] = interaction.customId.split('|');
    await interaction.deferUpdate();
    try {
      // attachments: [] drops the previous view's chart before the new files are added.
      return await interaction.editReply({ files: [], attachments: [], ...(await playerView(playerId, seasonKey, view)) });
    } catch (error) {
      console.error(error);
      return interaction.followUp({ content: 'ดึงข้อมูลผู้เล่นไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง', flags: MessageFlags.Ephemeral });
    }
  }
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    if (interaction.commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel', true);
      const kind = interaction.options.getString('type') ?? 'market';
      if (!channel.isTextBased()) return interaction.reply({ content: 'กรุณาเลือกห้องข้อความ', flags: MessageFlags.Ephemeral });
      await setChannel(interaction.guildId, channel.id, kind);
      const what = kind === 'stats' ? 'ห้องสถิติผู้เล่น (ผลของ /player จะส่งมาที่นี่)' : 'ห้องตลาด (คำแนะนำคราฟรายวันและ /postnow)';
      return interaction.reply({ content: `ตั้ง ${channel} เป็น${what}แล้ว`, flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === 'trackrole') {
      const role = interaction.options.getRole('role');
      await setGuildSetting(interaction.guildId, 'trackerRole', role?.id ?? null);
      return interaction.reply({
        content: role ? `สมาชิกที่มี ${role} ใช้ /track add และ /track remove ได้แล้ว (แอดมินใช้ได้เสมอ)` : 'ล้าง role แล้ว ตอนนี้ /track add และ /track remove ใช้ได้เฉพาะแอดมิน',
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }
    if (interaction.commandName === 'botstatus') {
      const [market, stats, trackerRole] = await Promise.all([
        getChannel(interaction.guildId, 'market'), getChannel(interaction.guildId, 'stats'), getGuildSetting(interaction.guildId, 'trackerRole'),
      ]);
      return interaction.reply({
        content: [
          `ห้องตลาด: ${market ? `<#${market}>` : 'ยังไม่ได้ตั้ง (ใช้ /setchannel type:ตลาด)'}`,
          `ห้องสถิติ: ${stats ? `<#${stats}>` : 'ยังไม่ได้ตั้ง (ผล /player จะขึ้นในห้องที่พิมพ์)'}`,
          `ใช้ /track add, remove ได้: แอดมิน${trackerRole ? ` และ <@&${trackerRole}>` : ' เท่านั้น (ตั้ง role ด้วย /trackrole)'}`,
          `Cooldown ของ /player และ /craft: ${config.commandCooldownSeconds ? `${config.commandCooldownSeconds} วินาทีต่อคน (แอดมินไม่ติด)` : 'ปิด'}`,
          `เวลาโพสต์: ${config.postTime} (${config.timeZone})`,
        ].join('\n'),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    }
    if (interaction.commandName === 'postnow') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channelId = await getChannel(interaction.guildId);
      if (!channelId) return interaction.editReply('ยังไม่ได้ตั้งห้อง ใช้ /setchannel ก่อน');
      await postToChannel(channelId);
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
        // Every looked-up player is tracked automatically so the Recent matches tab fills up without /track add.
        trackPlayer(config, interaction.guildId, report.player).catch((error) => console.warn(`Could not auto-track ${report.player.name}:`, error.message));
        const message = { ...(await makePlayerMessage(report)), components: [playerButtons(report.player.id, seasonKey, 'overview')] };
        if (!redirect) return interaction.editReply(message);
        const channel = await client.channels.fetch(statsChannelId);
        if (!channel?.isTextBased()) throw new Error('Stats channel is unavailable.');
        await channel.send({ content: `${interaction.user} ค้นหาสถิติของ **${report.player.name}**`, allowedMentions: { parse: [] }, ...message });
        return interaction.editReply(`ส่งสถิติของ **${report.player.name}** ไปที่ <#${statsChannelId}> แล้ว`);
      } catch (error) {
        if (error instanceof PlayerNotFoundError) return interaction.editReply(`ไม่พบผู้เล่นชื่อ **${query}** ลองเช็กตัวสะกด หรือใช้ Delta Force ID แทน`);
        console.error(error);
        return interaction.editReply('ดึงข้อมูลผู้เล่นไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง');
      }
    }
    if (interaction.commandName === 'track') {
      if (config.demoMode) return interaction.reply({ content: 'คำสั่งนี้ต้องใช้ข้อมูลจริงจาก API ตั้ง DEMO_MODE=false ก่อน', flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const players = await listTracked(interaction.guildId);
        const lines = players.map((player) => `${player.pinned ? '📌' : '🔄'} **${player.name}**  —  ${player.events.length} รายการ  •  ติดตามตั้งแต่ <t:${Math.floor(new Date(player.startedAt).getTime() / 1000)}:R>`);
        return interaction.reply({
          content: lines.length
            ? `ผู้เล่นที่ติดตาม (${players.length}/${MAX_PLAYERS_PER_GUILD})  •  📌 ถาวร  🔄 อัตโนมัติจาก /player (หยุดเมื่อไม่มีใครดู 14 วัน)\n${lines.join('\n').slice(0, 1_800)}`
            : 'ยังไม่ได้ติดตามใคร ค้นหาด้วย `/player` หรือ `/track add` เพื่อเริ่มติดตาม',
          flags: MessageFlags.Ephemeral,
        });
      }
      const name = interaction.options.getString('name', true).trim();
      if (!(await canManageTracking(interaction))) {
        return interaction.reply({ content: '/track add และ /track remove ใช้ได้เฉพาะแอดมิน หรือ role ที่แอดมินตั้งไว้ด้วย /trackrole', flags: MessageFlags.Ephemeral });
      }
      if (sub === 'remove') {
        const removed = await untrackPlayer(interaction.guildId, name);
        return interaction.reply({ content: removed ? `เลิกติดตาม **${removed}** แล้ว` : `ไม่ได้ติดตามผู้เล่นชื่อ **${name}** อยู่`, flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const player = await findPlayer(config, name);
        const result = await trackPlayer(config, interaction.guildId, player, { pinned: true });
        if (result.reason === 'full') return interaction.editReply(`ติดตามแบบถาวรได้สูงสุด ${MAX_PLAYERS_PER_GUILD} คนต่อเซิร์ฟเวอร์ ลบคนเก่าก่อนด้วย \`/track remove\``);
        if (result.reason === 'already') {
          return interaction.editReply(result.pinnedNow ? `ปักหมุด **${player.name}** แล้ว จะติดตามต่อไปแม้ไม่มีใครดูเกิน 14 วัน` : `ติดตาม **${player.name}** แบบถาวรอยู่แล้ว`);
        }
        return interaction.editReply(`เริ่มติดตาม **${player.name}** แบบถาวรแล้ว บอตจะเช็กทุก ${config.trackIntervalMinutes} นาที แมตช์ใหม่จะขึ้นในปุ่ม 📜 แมตช์ล่าสุด ของ \`/player\``);
      } catch (error) {
        if (error instanceof PlayerNotFoundError) return interaction.editReply(`ไม่พบผู้เล่นชื่อ **${name}** ลองเช็กตัวสะกด หรือใช้ Delta Force ID แทน`);
        console.error(error);
        return interaction.editReply('เริ่มติดตามไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง');
      }
    }
  } catch (error) {
    console.error(error);
    const response = 'โพสต์ไม่สำเร็จ กรุณาตรวจสอบ API endpoint, API token และสิทธิ์ของบอตในห้องนั้น';
    if (interaction.deferred || interaction.replied) await interaction.editReply(response);
    else await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
  }
});

client.login(config.botToken);
