import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

// Slash command definitions, shared by `npm run register` and the bot (which registers them in every
// server it joins). default_member_permissions only hides a command from members without that permission;
// server admins can still change who sees each command in Server Settings → Integrations.
export const commands = [
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
    .setName('craftpost')
    .setDescription('โพสต์คำแนะนำคราฟไปที่ห้องตลาดทันที')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('botstatus').setDescription('ดูการตั้งค่าของบอต'),
  new SlashCommandBuilder()
    .setName('craft')
    .setDescription('ดูสูตร กำไร และวัตถุดิบของไอเทมที่คราฟได้')
    .addStringOption((option) => option.setName('item').setDescription('ชื่อไอเทม').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('price')
    .setDescription('ดูราคาตลาดและกราฟราคา 7 วันของไอเทม')
    .addStringOption((option) => option.setName('item').setDescription('ชื่อไอเทม (ภาษาอังกฤษ)').setRequired(true).setAutocomplete(true).setMaxLength(100)),
  new SlashCommandBuilder()
    .setName('player')
    .setDescription('ดูสถิติผู้เล่น Delta Force โหมด Operations')
    .addStringOption((option) => option.setName('name').setDescription('ชื่อในเกม หรือ Delta Force ID').setRequired(true).setMaxLength(64))
    .addStringOption((option) => option
      .setName('season')
      .setDescription('ซีซันของสถิติ (ค่าเริ่มต้น: ซีซันปัจจุบัน)')
      .setAutocomplete(true)),
].map((command) => command.toJSON());
