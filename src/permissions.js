import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getGuildSetting } from './store.js';

export const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

// /track add and remove: server admins, or members with the role set by /trackrole.
export async function canManageTracking(interaction) {
  if (isAdmin(interaction)) return true;
  const roleId = await getGuildSetting(interaction.guildId, 'trackerRole');
  if (!roleId) return false;
  // Cached guild members expose a role manager; raw API members carry an array of role ids.
  const roles = interaction.member?.roles;
  return Boolean(roles?.cache ? roles.cache.has(roleId) : roles?.includes?.(roleId));
}

const cooldowns = new Map();

// Per-user cooldown for commands that call the API a lot. Admins are exempt. Buttons pass the name of
// the command whose cooldown they share, since they have no command name of their own.
// Returns the time left in ms, or 0 when the command may run (and starts the cooldown).
export function cooldownLeft(interaction, seconds, name = interaction.commandName, now = Date.now()) {
  if (!seconds || isAdmin(interaction)) return 0;
  const key = `${name}:${interaction.user.id}`;
  const until = cooldowns.get(key) ?? 0;
  if (until > now) return until - now;
  cooldowns.set(key, now + seconds * 1000);
  for (const [entry, expires] of cooldowns) if (expires <= now) cooldowns.delete(entry);
  return 0;
}

export const cooldownReply = (ms) => ({ content: `ใช้คำสั่งนี้ได้อีกครั้ง <t:${Math.ceil((Date.now() + ms) / 1000)}:R>`, flags: MessageFlags.Ephemeral });
