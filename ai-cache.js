import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CHAOS } from './helpers.js';

export const AI_CACHE_DIR = new URL('./data/ai-cache/', import.meta.url).pathname;
mkdirSync(AI_CACHE_DIR, { recursive: true });

export function readCacheEntry(key) {
  if (CHAOS && Math.random() < 0.2) throw new Error(`[CHAOS] cache read failure for ${key}`);
  const path = `${AI_CACHE_DIR}${key}.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
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
    const path = `${AI_CACHE_DIR}${file}`;
    if (!existsSync(path)) continue;
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    if (new Date(entry.timestamp).getTime() < cutoff) {
      unlinkSync(path);
      removed++;
    }
  }
  if (removed > 0) console.log(`Cleaned ${removed} stale cache entries`);
}
