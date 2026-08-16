const axios = require('axios');

async function searchFoodPhotos({ apiKey, query, count = 3 }) {
  if (!apiKey) return [];
  const q = String(query || '').trim();
  if (!q) return [];

  const wanted = Math.max(1, Math.min(3, Number(count) || 3));
  const res = await axios.get('https://api.pexels.com/v1/search', {
    headers: { Authorization: apiKey },
    params: {
      query: `${q} korean food dish`,
      per_page: 15,
      orientation: 'portrait',
      size: 'large',
    },
    timeout: 15000,
  });

  const photos = Array.isArray(res.data?.photos) ? res.data.photos : [];
  const seen = new Set();

  return photos
    .filter((photo) => {
      if (!photo?.id || seen.has(photo.id)) return false;
      seen.add(photo.id);
      return true;
    })
    .slice(0, wanted)
    .map((photo) => ({
      id: photo.id,
      imageUrl: photo.src?.large2x || photo.src?.large || photo.src?.portrait || photo.src?.original || null,
      photographer: photo.photographer || '',
      photographerUrl: photo.photographer_url || '',
      pexelsUrl: photo.url || '',
    }))
    .filter((photo) => photo.imageUrl);
}

async function searchFoodPhoto({ apiKey, query }) {
  const photos = await searchFoodPhotos({ apiKey, query, count: 1 });
  return photos[0] || null;
}

module.exports = { searchFoodPhoto, searchFoodPhotos };
