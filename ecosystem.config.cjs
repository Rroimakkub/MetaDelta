// pm2 process file: keeps the bot running in the background and restarts it if it crashes.
// Start with `npm run bot:start`; see README "รันบอตตลอดเวลา".
module.exports = {
  apps: [
    {
      name: 'metadelta-bot',
      script: 'src/index.js',
      cwd: __dirname,
      // Wait before restarting after a crash, and stop retrying if it keeps failing right away.
      restart_delay: 10_000,
      max_restarts: 20,
      min_uptime: 30_000,
      time: true,
    },
  ],
};
