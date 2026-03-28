'use strict';

/**
 * /help command
 *
 * Lists all available commands with descriptions.
 */
module.exports = function registerHelp(bot) {
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `<b>🌿 Wildlife &amp; Sightings Bot — Commands</b>\n\n` +
      `<b>Identification</b>\n` +
      `📸 Send any photo — I'll identify the animal\n` +
      `/identify_url &lt;url&gt; — identify from an image URL\n\n` +
      `<b>Bird Sightings</b>\n` +
      `/nearby &lt;lat&gt; &lt;lng&gt; — recent birds near a location\n` +
      `/region &lt;code&gt; — recent birds in a region (e.g. US-CA)\n` +
      `/notable &lt;code&gt; — notable/rare sightings in a region\n\n` +
      `<b>Hotspots</b>\n` +
      `/hotspots &lt;lat&gt; &lt;lng&gt; — birding hotspots near you\n\n` +
      `<b>Species</b>\n` +
      `/search &lt;name&gt; — search bird species by name\n\n` +
      `<b>General</b>\n` +
      `/start — welcome message\n` +
      `/help — show this message\n` +
      `/about — about this bot`,
      { parse_mode: 'HTML' }
    );
  });
};
