'use strict';

const ITEMS_PER_PAGE = 10;
const LOGS_PER_PAGE  = 5;

const LOCATION_TO_CODE = {
  // Asia
  singapore: 'SG', malaysia: 'MY', thailand: 'TH', vietnam: 'VN',
  indonesia: 'ID', philippines: 'PH', japan: 'JP', china: 'CN',
  india: 'IN', 'south korea': 'KR', korea: 'KR', taiwan: 'TW',
  'hong kong': 'HK', cambodia: 'KH', myanmar: 'MM', burma: 'MM',
  laos: 'LA', bangladesh: 'BD', nepal: 'NP', 'sri lanka': 'LK',
  pakistan: 'PK', brunei: 'BN', maldives: 'MV', mongolia: 'MN',
  // Middle East
  uae: 'AE', 'united arab emirates': 'AE', israel: 'IL', jordan: 'JO',
  oman: 'OM', qatar: 'QA', bahrain: 'BH', kuwait: 'KW',
  // Europe
  'united kingdom': 'GB', uk: 'GB', england: 'GB-ENG', scotland: 'GB-SCT',
  wales: 'GB-WLS', 'great britain': 'GB', germany: 'DE', france: 'FR',
  spain: 'ES', portugal: 'PT', italy: 'IT', netherlands: 'NL',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI',
  switzerland: 'CH', austria: 'AT', belgium: 'BE', poland: 'PL',
  czechia: 'CZ', 'czech republic': 'CZ', hungary: 'HU', greece: 'GR',
  ireland: 'IE', russia: 'RU',
  // Americas
  'united states': 'US', usa: 'US', 'u.s.a.': 'US',
  canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR',
  colombia: 'CO', peru: 'PE', chile: 'CL', ecuador: 'EC',
  'costa rica': 'CR', panama: 'PA', venezuela: 'VE',
  california: 'US-CA', florida: 'US-FL', texas: 'US-TX',
  'new york': 'US-NY', oregon: 'US-OR', washington: 'US-WA',
  massachusetts: 'US-MA', arizona: 'US-AZ', colorado: 'US-CO',
  // Oceania
  australia: 'AU', 'new zealand': 'NZ', 'papua new guinea': 'PG',
  // Africa
  'south africa': 'ZA', kenya: 'KE', tanzania: 'TZ', ghana: 'GH',
  nigeria: 'NG', ethiopia: 'ET', uganda: 'UG', zimbabwe: 'ZW',
};

const REGION_TIMEZONE = {
  // Asia
  SG: 'Asia/Singapore',    MY: 'Asia/Kuala_Lumpur',   JP: 'Asia/Tokyo',
  CN: 'Asia/Shanghai',     HK: 'Asia/Hong_Kong',      TW: 'Asia/Taipei',
  KR: 'Asia/Seoul',        TH: 'Asia/Bangkok',        VN: 'Asia/Ho_Chi_Minh',
  ID: 'Asia/Jakarta',      PH: 'Asia/Manila',         IN: 'Asia/Kolkata',
  KH: 'Asia/Phnom_Penh',  MM: 'Asia/Rangoon',        LA: 'Asia/Vientiane',
  BD: 'Asia/Dhaka',        NP: 'Asia/Kathmandu',      LK: 'Asia/Colombo',
  BN: 'Asia/Brunei',       MN: 'Asia/Ulaanbaatar',    MV: 'Indian/Maldives',
  KZ: 'Asia/Almaty',       UZ: 'Asia/Tashkent',       TM: 'Asia/Ashgabat',
  TJ: 'Asia/Dushanbe',     KG: 'Asia/Bishkek',        GE: 'Asia/Tbilisi',
  AM: 'Asia/Yerevan',      AZ: 'Asia/Baku',           IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran',       SY: 'Asia/Damascus',       LB: 'Asia/Beirut',
  YE: 'Asia/Aden',         AF: 'Asia/Kabul',
  // Middle East
  AE: 'Asia/Dubai',        SA: 'Asia/Riyadh',         IL: 'Asia/Jerusalem',
  PK: 'Asia/Karachi',      JO: 'Asia/Amman',          QA: 'Asia/Qatar',
  BH: 'Asia/Bahrain',      KW: 'Asia/Kuwait',         OM: 'Asia/Muscat',
  // Oceania
  AU: 'Australia/Sydney',  NZ: 'Pacific/Auckland',    PG: 'Pacific/Port_Moresby',
  FJ: 'Pacific/Fiji',      SB: 'Pacific/Guadalcanal', VU: 'Pacific/Efate',
  WS: 'Pacific/Apia',      TO: 'Pacific/Tongatapu',
  // Australia states
  'AU-NSW': 'Australia/Sydney',    'AU-VIC': 'Australia/Melbourne',
  'AU-QLD': 'Australia/Brisbane',  'AU-SA':  'Australia/Adelaide',
  'AU-WA':  'Australia/Perth',     'AU-TAS': 'Australia/Hobart',
  'AU-NT':  'Australia/Darwin',    'AU-ACT': 'Australia/Sydney',
  // Europe
  GB: 'Europe/London',     IE: 'Europe/Dublin',       FR: 'Europe/Paris',
  DE: 'Europe/Berlin',     NL: 'Europe/Amsterdam',    IT: 'Europe/Rome',
  ES: 'Europe/Madrid',     PT: 'Europe/Lisbon',       SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',       DK: 'Europe/Copenhagen',   FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',     CH: 'Europe/Zurich',       AT: 'Europe/Vienna',
  BE: 'Europe/Brussels',   CZ: 'Europe/Prague',       GR: 'Europe/Athens',
  HU: 'Europe/Budapest',   RO: 'Europe/Bucharest',    BG: 'Europe/Sofia',
  HR: 'Europe/Zagreb',     SK: 'Europe/Bratislava',   SI: 'Europe/Ljubljana',
  LT: 'Europe/Vilnius',    LV: 'Europe/Riga',         EE: 'Europe/Tallinn',
  UA: 'Europe/Kiev',       BY: 'Europe/Minsk',        RS: 'Europe/Belgrade',
  BA: 'Europe/Sarajevo',   ME: 'Europe/Podgorica',    MK: 'Europe/Skopje',
  AL: 'Europe/Tirane',     MD: 'Europe/Chisinau',     LU: 'Europe/Luxembourg',
  IS: 'Atlantic/Reykjavik', MT: 'Europe/Malta',       CY: 'Asia/Nicosia',
  RU: 'Europe/Moscow',     TR: 'Europe/Istanbul',
  // Americas
  US: 'America/New_York',  CA: 'America/Toronto',     MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires',
  CO: 'America/Bogota',    PE: 'America/Lima',        CL: 'America/Santiago',
  EC: 'America/Guayaquil', CR: 'America/Costa_Rica',  PA: 'America/Panama',
  VE: 'America/Caracas',   BO: 'America/La_Paz',      PY: 'America/Asuncion',
  UY: 'America/Montevideo', GT: 'America/Guatemala',  HN: 'America/Tegucigalpa',
  SV: 'America/El_Salvador', NI: 'America/Managua',   CU: 'America/Havana',
  JM: 'America/Jamaica',   TT: 'America/Port_of_Spain', DO: 'America/Santo_Domingo',
  GY: 'America/Guyana',    SR: 'America/Paramaribo',  BZ: 'America/Belize',
  HT: 'America/Port-au-Prince',
  // US states
  'US-CA': 'America/Los_Angeles', 'US-OR': 'America/Los_Angeles',
  'US-WA': 'America/Los_Angeles', 'US-NV': 'America/Los_Angeles',
  'US-AZ': 'America/Phoenix',     'US-HI': 'Pacific/Honolulu',
  'US-AK': 'America/Anchorage',   'US-TX': 'America/Chicago',
  'US-IL': 'America/Chicago',     'US-MN': 'America/Chicago',
  'US-WI': 'America/Chicago',     'US-MO': 'America/Chicago',
  'US-LA': 'America/Chicago',     'US-MS': 'America/Chicago',
  'US-AL': 'America/Chicago',     'US-TN': 'America/Chicago',
  'US-CO': 'America/Denver',      'US-UT': 'America/Denver',
  'US-MT': 'America/Denver',      'US-NM': 'America/Denver',
  'US-WY': 'America/Denver',      'US-ID': 'America/Boise',
  // Canada provinces
  'CA-BC': 'America/Vancouver',   'CA-AB': 'America/Edmonton',
  'CA-SK': 'America/Regina',      'CA-ON': 'America/Toronto',
  'CA-QC': 'America/Montreal',    'CA-NS': 'America/Halifax',
  'CA-NB': 'America/Moncton',     'CA-NL': 'America/St_Johns',
  'CA-YT': 'America/Whitehorse',  'CA-NT': 'America/Yellowknife',
  'CA-NU': 'America/Iqaluit',
  // Africa
  ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi',    EG: 'Africa/Cairo',
  TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala',   GH: 'Africa/Accra',
  NG: 'Africa/Lagos',        ET: 'Africa/Addis_Ababa', ZW: 'Africa/Harare',
  MZ: 'Africa/Maputo',       CM: 'Africa/Douala',      CI: 'Africa/Abidjan',
  SN: 'Africa/Dakar',        MA: 'Africa/Casablanca',  TN: 'Africa/Tunis',
  DZ: 'Africa/Algiers',      LY: 'Africa/Tripoli',     SD: 'Africa/Khartoum',
  SS: 'Africa/Juba',         AO: 'Africa/Luanda',      ZM: 'Africa/Lusaka',
  RW: 'Africa/Kigali',       MG: 'Indian/Antananarivo', NA: 'Africa/Windhoek',
  BW: 'Africa/Gaborone',     LS: 'Africa/Maseru',       MW: 'Africa/Blantyre',
  BI: 'Africa/Bujumbura',    SO: 'Africa/Mogadishu',   ER: 'Africa/Asmara',
  DJ: 'Africa/Djibouti',     ML: 'Africa/Bamako',       BF: 'Africa/Ouagadougou',
  NE: 'Africa/Niamey',       TD: 'Africa/Ndjamena',     GA: 'Africa/Libreville',
  CG: 'Africa/Brazzaville',  CD: 'Africa/Kinshasa',     GQ: 'Africa/Malabo',
  GN: 'Africa/Conakry',      SL: 'Africa/Freetown',     GM: 'Africa/Banjul',
  TG: 'Africa/Lome',         BJ: 'Africa/Porto-Novo',   MR: 'Africa/Nouakchott',
  CV: 'Atlantic/Cape_Verde',
};

const BREEDING_CODES = {
  F: 'Flyover', H: 'In appropriate habitat', S: 'Singing bird',
  P: 'Pair in suitable habitat', M: 'Multiple (7+) singing birds',
  S7: 'Singing bird present 7+ days', T: 'Territorial defence',
  C: 'Courtship, display or copulation', N: 'Visiting probable nest site',
  A: 'Agitated behaviour', B: 'Wren/woodpecker nest building',
  CN: 'Carrying nesting material', PE: 'Physiological evidence',
  NB: 'Nest building', DD: 'Distraction display', UN: 'Used nest',
  ON: 'Occupied nest', CF: 'Carrying food', FS: 'Carrying fecal sac',
  FY: 'Feeding young', FL: 'Recently fledged young',
  NE: 'Nest with eggs', NY: 'Nest with young', X: 'Species observed',
  OS: 'Over-summering (outside breeding range)',
};

const AGE_LABELS = {
  adult:       'Adult',
  subadult:    'Sub-adult',
  juvenile:    'Juvenile',
  immature:    'Immature',
  age_unknown: 'Age?',
};
const SEX_ICONS  = { m: ' ♂', f: ' ♀', u: ' ?' };

const SIGHTINGS_CATEGORY_MENU = {
  parse_mode: 'Markdown',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🐦 eBird',   callback_data: 'bird_sightings' },
        { text: '📓 My Logs', callback_data: 'bird_logs'      },
      ],
      [
        { text: '✅ Done', callback_data: 'done' },
      ],
    ],
  },
};

module.exports = {
  ITEMS_PER_PAGE, LOGS_PER_PAGE,
  LOCATION_TO_CODE, REGION_TIMEZONE,
  BREEDING_CODES, AGE_LABELS, SEX_ICONS,
  SIGHTINGS_CATEGORY_MENU,
};
