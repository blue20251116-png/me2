const axios = require('axios');

async function searchFoodPhoto({ apiKey, query }) {
  if (!apiKey) return null;
  const q = String(query || '').trim();
  if (!q) return null;

  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: apiKey },
    params: {
      query: `${q} korean food dish`,
      per_page: 12,
      orientation: 'portrait',
      size: 'large',
    },
    timeout: 15000,
  });

  const photos = Array.isArray(res.data?.photos) ? res.data.photos : [];
  if (!photos.length) return null;

  const photo = photos[0];
  return {
    id: photo.id,
    imageUrl: photo.src?.large2x || photo.src?.large || photo.src?.portrait || photo.src?.original || null,
    photographer: photo.photographer || '',
    photographerUrl: photo.photographer_url || '',
    pexelsUrl: photo.url || '',
  };
}

module.exports = { searchFoodPhoto };
