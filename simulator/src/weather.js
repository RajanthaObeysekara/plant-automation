// Pulls real current conditions for each farm's location from Open-Meteo (no
// API key needed) so the simulated sensor readings track what the weather is
// actually doing right now, instead of a purely made-up baseline. Cached
// per farm and refreshed on a timer; falls back to a sane tropical-Sri-Lanka
// default if the fetch fails so a network blip never stalls the fleet.

const FARM_COORDS = {
  'Kadawatha Farm': { lat: 7.0091, lon: 79.9553 },
  'Raddolugama Farm': { lat: 7.0333, lon: 79.9333 },
};
const DEFAULT_COORDS = { lat: 6.9271, lon: 79.8612 }; // Colombo, used for any farm not listed above
const FALLBACK = { tempC: 29, humidity: 70, precipitationMm: 0 };

const cache = new Map(); // farmName -> { tempC, humidity, precipitationMm, fetchedAt }

async function fetchOne(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation&timezone=Asia%2FColombo`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
  const body = await res.json();
  return {
    tempC: body.current.temperature_2m,
    humidity: body.current.relative_humidity_2m,
    precipitationMm: body.current.precipitation ?? 0,
    fetchedAt: Date.now(),
  };
}

async function refreshFarm(farmName) {
  const coords = FARM_COORDS[farmName] || DEFAULT_COORDS;
  try {
    const reading = await fetchOne(coords.lat, coords.lon);
    cache.set(farmName, reading);
    console.log(`[weather] ${farmName}: ${reading.tempC}°C, ${reading.humidity}% RH, ${reading.precipitationMm}mm precip`);
  } catch (err) {
    console.warn(`[weather] fetch failed for ${farmName}, keeping last known value:`, err.message);
  }
}

async function refreshAll(farmNames) {
  await Promise.all(farmNames.map(refreshFarm));
}

function getBaseline(farmName) {
  return cache.get(farmName) || FALLBACK;
}

module.exports = { refreshAll, getBaseline };
