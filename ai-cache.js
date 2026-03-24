import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CHAOS } from './helpers.js';

export const AI_CACHE_DIR = new URL('./data/ai-cache/', import.meta.url).pathname;
mkdirSync(AI_CACHE_DIR, { recursive: true });

export function readCacheEntry(key) {
  if (CHAOS && Math.random() < 0.2) { console.error(`[CHAOS] cache read failure for ${key}`); return null; }
  try { return JSON.parse(readFileSync(`${AI_CACHE_DIR}${key}.json`, 'utf8')); } catch (e) { console.error(`Failed to read cache entry ${key}:`, e); return null; }
}

export function writeCacheEntry(key, entry) {
  if (CHAOS && Math.random() < 0.2) throw new Error(`[CHAOS] cache write failure for ${key}`);
  writeFileSync(`${AI_CACHE_DIR}${key}.json`, JSON.stringify(entry, null, 2) + '\n');
}

export function hashPrompt(prompt) {
  return createHash('md5').update(prompt).digest('hex');
}

export function cleanAiCache(maxAgeDays = 3) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of readdirSync(AI_CACHE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(`${AI_CACHE_DIR}${file}`, 'utf8'));
      if (new Date(entry.timestamp).getTime() < cutoff) {
        unlinkSync(`${AI_CACHE_DIR}${file}`);
        removed++;
      }
    } catch (e) { console.error(`Failed to process cache file ${file}:`, e); }
  }
  if (removed > 0) console.log(`Cleaned ${removed} stale cache entries`);
}
