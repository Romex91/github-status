import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export const REPO_COLORS = [
  '#58a6ff', '#f778ba', '#7ee787', '#ffa657', '#d2a8ff',
  '#ff7b72', '#56d4dd', '#d29922', '#e0e037', '#f0883e',
  '#b392f0', '#85e89d', '#79e2f2', '#ffab70', '#db61a2',
];

const REPO_COLORS_PATH = new URL('./data/repo-colors.json', import.meta.url).pathname;

export function loadRepoColors() {
  try { return JSON.parse(readFileSync(REPO_COLORS_PATH, 'utf8')); } catch (e) { console.error('Failed to load repo colors:', e); return {}; }
}

export function saveRepoColors(map) {
  mkdirSync(new URL('./data/', import.meta.url).pathname, { recursive: true });
  writeFileSync(REPO_COLORS_PATH, JSON.stringify(map, null, 2) + '\n');
}

export function updateRepoColors(repoNames) {
  const saved = loadRepoColors();
  const allRepos = [...new Set([...Object.keys(saved), ...repoNames])].sort();
  const map = {};
  allRepos.forEach((name, i) => { map[name] = REPO_COLORS[i % REPO_COLORS.length]; });
  saveRepoColors(map);
  return map;
}

export function repoColor(repoColorMap, repoName) {
  return repoColorMap[repoName] || '#8b949e';
}
