import { MessageFlags, PermissionFlagsBits } from 'discord.js';

export const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

const cooldowns = new Map();

// Per-user cooldown for commands that call the API a lot. Admins are exempt.
// Returns the time left in ms, or 0 when the command may run (and starts the cooldown).
export function cooldownLeft(interaction, seconds, now = Date.now()) {
  if (!seconds || isAdmin(interaction)) return 0;
  const key = `${interaction.commandName}:${interaction.user.id}`;
  const until = cooldowns.get(key) ?? 0;
  if (until > now) return until - now;
  cooldowns.set(key, now + seconds * 1000);
  for (const [entry, expires] of cooldowns) if (expires <= now) cooldowns.delete(entry);
  return 0;
}

// Gives the cooldown back, e.g. when a typo meant the command found nothing.
export function refundCooldown(interaction) {
  cooldowns.delete(`${interaction.commandName}:${interaction.user.id}`);
}

export const cooldownReply =(ms) => ({ content: `ใช้คำสั่งนี้ได้อีกครั้ง <t:${Math.ceil((Date.now() + ms) / 1000)}:R>`, flags: MessageFlags.Ephemeral });
