const axios = require('axios');

/**
 * Fetch Wikipedia page URL and summary for a given species name.
 * @param {string} name - Common or scientific name
 * @returns {Promise<{url: string, summary: string}|null>}
 */
async function getWikipediaInfo(name) {
  if (!name) return null;
  try {
    // Use Wikipedia API to get the page summary, canonical URL, and thumbnail
    const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, '_'))}`;
    const resp = await axios.get(apiUrl, { headers: { 'User-Agent': 'WildlifeBot/1.0' } });
    if (resp.data && resp.data.content_urls && resp.data.content_urls.desktop && resp.data.extract) {
      const imageUrl =
        resp.data.originalimage?.source ||
        resp.data.thumbnail?.source ||
        null;
      return {
        url: resp.data.content_urls.desktop.page,
        summary: resp.data.extract,
        imageUrl,
      };
    }
  } catch (err) {
    // Not found or error
  }
  return null;
}

module.exports = { getWikipediaInfo };
