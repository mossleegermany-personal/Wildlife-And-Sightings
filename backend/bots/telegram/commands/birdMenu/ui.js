'use strict';

// Shared menu UI and keyboard definitions for bird commands

const SIGHTINGS_CATEGORY_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🐦 eBird',   callback_data: 'menu_ebird' },
        { text: '📓 My Logs', callback_data: 'bird_logs'  },
      ],
      [
        { text: '✅ Done',    callback_data: 'done'       },
      ],
    ],
  },
};

const EBIRD_SUBMENU = {
  parse_mode: 'Markdown',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔍 Sightings', callback_data: 'bird_sightings' },
        { text: '⭐ Notable',   callback_data: 'bird_notable'    },
      ],
      [
        { text: '📍 Nearby',   callback_data: 'bird_nearby'     },
        { text: '🦆 Species',  callback_data: 'bird_species'    },
      ],
      [
        { text: '🗺️ Hotspots', callback_data: 'bird_hotspot'    },
      ],
      [
        { text: '⬅️ Back',    callback_data: 'bird_back_main'  },
        { text: '✅ Done',    callback_data: 'done'            },
      ],
    ],
  },
};

async function sendSightingsCategoryMenu(bot, chatId) {
  return bot.sendMessage(chatId, '🐦 *Bird Sightings*\n\nChoose a category to explore:', {
    parse_mode: 'Markdown',
    reply_markup: SIGHTINGS_CATEGORY_MENU.reply_markup,
  });
}

async function sendEbirdSubmenu(bot, chatId) {
  return bot.sendMessage(chatId, '🐦 Bird Sightings\n\nChoose a search type:', EBIRD_SUBMENU);
}

module.exports = {
  SIGHTINGS_CATEGORY_MENU,
  EBIRD_SUBMENU,
  sendSightingsCategoryMenu,
  sendEbirdSubmenu,
};
