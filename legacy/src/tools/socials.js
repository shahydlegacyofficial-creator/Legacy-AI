/**
 * Manual social stats — TikTok has no simple personal API, so these numbers
 * live in data/socials.json and Shahyd updates them by just telling Legacy
 * ("my TikTok hit 12.4k"). Shown on the vitals panel. When a real TikTok
 * integration lands, this file becomes its cache and nothing else changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
const FILE = new URL('socials.json', DATA_DIR);

/** The one writer — voice, and now the automatic TikTok check, both use it. */
export function setSocialStat(platform, { followers, lastVideoViews, source } = {}) {
  const s = loadSocials();
  s[platform] = {
    followers: followers ?? s[platform]?.followers ?? null,
    lastVideoViews: lastVideoViews ?? s[platform]?.lastVideoViews ?? null,
    updatedAt: new Date().toISOString(),
    source: source ?? 'told',
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
  return s[platform];
}

export function loadSocials() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { tiktok: { followers: null, lastVideoViews: null, updatedAt: null } }; }
}

registerTool({
  name: 'update_social_stat',
  description:
    "Update Shahyd's manually-tracked social numbers shown on his vitals " +
    'panel (currently TikTok — it has no simple API). Use when he tells you ' +
    'his TikTok follower count or how many views his last TikTok video got.',
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: ['tiktok'] },
      followers: { type: 'integer', description: 'Total followers, e.g. 12400.' },
      last_video_views: { type: 'integer', description: 'Views on the latest video.' },
    },
    required: ['platform'],
  },
  handler: ({ platform, followers, last_video_views }) => {
    const s = loadSocials();
    s[platform] = {
      followers: followers ?? s[platform]?.followers ?? null,
      lastVideoViews: last_video_views ?? s[platform]?.lastVideoViews ?? null,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
    return `Updated ${platform}: ${s[platform].followers ?? '—'} followers, last video ${s[platform].lastVideoViews ?? '—'} views.`;
  },
});
