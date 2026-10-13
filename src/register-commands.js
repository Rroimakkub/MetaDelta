import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { getConfig } from './config.js';

const config = getConfig();

// Guild commands show up immediately, unlike global ones that Discord clients may not pick up.
// Register in every server the bot is in, then clear the global set so commands are not listed twice.
// The running bot also does this on startup and when it joins a server, so this is only needed while it's offline.
const rest = new REST({ version: '10' }).setToken(config.botToken);
const guilds = await rest.get(Routes.userGuilds());
for (const guild of guilds) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, guild.id), { body: commands });
  console.log(`Registered ${commands.length} commands in ${guild.name}.`);
}
await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
console.log('Cleared global commands.');
