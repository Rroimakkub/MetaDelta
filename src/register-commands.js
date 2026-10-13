import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getConfig } from './config.js';

const config = getConfig();
const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('ตั้งห้องสำหรับโพสต์ข้อมูล Delta Force อัตโนมัติ')
    .addChannelOption((option) => option.setName('channel').setDescription('ห้องข้อความปลายทาง').setRequired(true))
    .addStringOption((option) => option
      .setName('type')
      .setDescription('ใช้ห้องนี้สำหรับอะไร (ค่าเริ่มต้น: ตลาด)')
      .addChoices({ name: 'ตลาด / คำแนะนำคราฟ', value: 'market' }, { name: 'สถิติผู้เล่น', value: 'stats' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('postnow')
    .setDescription('โพสต์ข้อมูล Delta Force ทันที')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('botstatus').setDescription('ดูการตั้งค่าห้องโพสต์ของบอต'),
  new SlashCommandBuilder()
    .setName('craft')
    .setDescription('ดูสูตร กำไร และวัตถุดิบของไอเทมที่คราฟได้')
    .addStringOption((option) => option.setName('item').setDescription('ชื่อไอเทม').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('player')
    .setDescription('ดูสถิติผู้เล่น Delta Force โหมด Operations')
    .addStringOption((option) => option.setName('name').setDescription('ชื่อในเกม หรือ Delta Force ID').setRequired(true).setMaxLength(64))
    .addStringOption((option) => option
      .setName('season')
      .setDescription('ซีซันของสถิติ (ค่าเริ่มต้น: ซีซันปัจจุบัน)')
      .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('ติดตามผู้เล่นเพื่อบันทึกแมตช์ล่าสุด')
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('เริ่มติดตามผู้เล่น')
      .addStringOption((option) => option.setName('name').setDescription('ชื่อในเกม หรือ Delta Force ID').setRequired(true).setMaxLength(64)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('เลิกติดตามผู้เล่น')
      .addStringOption((option) => option.setName('name').setDescription('ชื่อผู้เล่นที่ติดตามอยู่').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('ดูรายชื่อผู้เล่นที่ติดตามอยู่')),
].map((command) => command.toJSON());

// Guild commands show up immediately, unlike global ones that Discord clients may not pick up.
// Register in every server the bot is in, then clear the global set so commands are not listed twice.
// Run this again after inviting the bot to a new server.
const rest = new REST({ version: '10' }).setToken(config.botToken);
const guilds = await rest.get(Routes.userGuilds());
for (const guild of guilds) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, guild.id), { body: commands });
  console.log(`Registered ${commands.length} commands in ${guild.name}.`);
}
await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
console.log('Cleared global commands.');
