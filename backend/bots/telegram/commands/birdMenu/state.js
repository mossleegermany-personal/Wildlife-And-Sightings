'use strict';

// One Map per chatId — persisted for the lifetime of the process
const userStates          = new Map(); // chatId → { action, regionCode, displayName, type, species, isHotspot, context, ... }
const observationsCache   = new Map(); // e.g. 'sightings_12345' → { observations, displayName, regionCode, type, dateLabel }
const lastPrompts         = new Map(); // chatId → { message, action }
const birdSessionMap      = new Map(); // chatId → { sn, sessionId }
// subId → { observerName, obsMap: Map<speciesCode, { comments, breedingCode, ageSex, mlMedia, obsId }> }
const checklistCommentCache = new Map();

module.exports = { userStates, observationsCache, lastPrompts, birdSessionMap, checklistCommentCache };
