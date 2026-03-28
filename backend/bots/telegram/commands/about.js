'use strict';

/**
 * /about command
 *
 * Brief info about the bot and its data sources.
 */
module.exports = function registerAbout(bot) {
  bot.onText(/\/about/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `<b>🌿 About Wildlife &amp; Sightings Bot</b>\n\n` +
      `This bot is powered by:\n` +
      `• 🤖 <b>Google Gemini AI</b> — animal identification\n` +
      `• 🐦 <b>eBird</b> — bird sightings &amp; hotspots (Cornell Lab)\n` +
      `• 🌍 <b>GBIF</b> — global biodiversity taxonomy\n` +
      `• 📷 <b>iNaturalist</b> — species reference photos\n\n` +
      `Send a photo to identify an animal, or use /help for all commands.`,
      { parse_mode: 'HTML' }
    );
  });
};
