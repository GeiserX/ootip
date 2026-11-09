// SPDX-License-Identifier: MIT
// Suggests a split from who actually wrote the code: GitHub's per-author commit counts.

export const TOTAL_BPS = 10_000;
export const MAX_RECIPIENTS = 16;

export interface Contributor {
  login: string;
  commits: number;
}

/**
 * Turns weights into basis points that add up to exactly 10,000, using the largest-remainder
 * method so the rounding is as fair as it can be. Every entry gets at least 1 bps.
 */
export function toBps(weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (weights.length > TOTAL_BPS) throw new Error("too many recipients");
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("weights must add up to more than zero");
  const spare = TOTAL_BPS - weights.length; // reserve the 1 bps floor for everyone
  const exact = weights.map((w) => (w / total) * spare);
  const out = exact.map((x) => Math.floor(x) + 1);
  let left = TOTAL_BPS - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/** The top contributors by commits, bots left out, at most 16. */
export function pickContributors(list: { login?: string; type?: string; contributions?: number }[]): Contributor[] {
  return list
    .filter((c) => c.login && c.type !== "Bot" && !c.login.endsWith("[bot]") && (c.contributions ?? 0) > 0)
    .map((c) => ({ login: c.login as string, commits: c.contributions as number }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, MAX_RECIPIENTS);
}

export async function suggestSplit(repo: string, fetcher = fetch): Promise<{ login: string; commits: number; bps: number }[]> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/contributors?per_page=100`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}'s contributors`);
  const people = pickContributors(await res.json());
  const bps = toBps(people.map((p) => p.commits));
  return people.map((p, i) => ({ ...p, bps: bps[i] }));
}
