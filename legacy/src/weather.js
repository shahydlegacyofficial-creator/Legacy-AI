/**
 * Weather for Malé (v1.47).
 *
 * Open-Meteo, chosen deliberately: no API key, no signup, no account to keep
 * alive. Every feature that needed painful setup on Shahyd's side has ended up
 * dropped, so the bar for a small convenience like this is "it must cost him
 * nothing to keep working".
 *
 * Cached for 20 minutes and stale-tolerant — a weather card that shows the
 * last known reading is useful; one that shows an error is not.
 */
import { config } from './config.js';

let cache = { at: 0, data: null };

// WMO weather codes, in the words a person would actually use.
const CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};
export const describeCode = (c) => CODES[c] ?? 'unsettled';

export async function currentWeather() {
  const w = config.weather ?? {};
  if (w.enabled === false) return null;
  const ttl = (w.cacheMinutes ?? 20) * 60_000;
  if (cache.data && Date.now() - cache.at < ttl) return cache.data;

  const lat = w.latitude ?? 4.1755;   // Malé
  const lon = w.longitude ?? 73.5093;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=${encodeURIComponent(w.timezone ?? 'Indian/Maldives')}&forecast_days=1`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const d = await res.json();
    const c = d.current ?? {};
    const day = d.daily ?? {};
    cache = {
      at: Date.now(),
      data: {
        place: w.place ?? "Malé",
        temp: Math.round(c.temperature_2m ?? 0),
        feelsLike: Math.round(c.apparent_temperature ?? c.temperature_2m ?? 0),
        humidity: Math.round(c.relative_humidity_2m ?? 0),
        wind: Math.round(c.wind_speed_10m ?? 0),
        code: c.weather_code ?? 0,
        text: describeCode(c.weather_code),
        high: Math.round(day.temperature_2m_max?.[0] ?? 0),
        low: Math.round(day.temperature_2m_min?.[0] ?? 0),
        rainChance: Math.round(day.precipitation_probability_max?.[0] ?? 0),
        at: new Date().toISOString(),
      },
    };
    return cache.data;
  } catch {
    return cache.data; // stale beats broken
  }
}
