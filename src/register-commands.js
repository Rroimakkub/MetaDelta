import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getConfig } from './config.js';

const config = getConfig();
const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('ตั้งห้องสำหรับโพสต์ข้อมูล Delta Force อัตโนมัติ')
    .addChannelOption((option) => option.setName('channel').setDescription('ห้องข้อความปลายทาง').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('postnow')
    .setDescription('โพสต์ข้อมูล Delta Force ทันที')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('botstatus').setDescription('ดูการตั้งค่าห้องโพสต์ของบอต'),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(config.botToken);
await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
console.log('Registered slash commands.');
