// SPDX-License-Identifier: MIT
import { base64ToBytes, bytesToHex, decode, Tagged, type Cbor } from "./cbor";

export type NetworkName = "esmeralda" | "mainnet" | "localnet";

export const NETWORKS: Record<NetworkName, { indexer: string; template: string | null }> = {
  esmeralda: {
    indexer: "https://esme-indexer-a.ootle.tari.com",
    template: "template_ba8e5f7dd4f459c3323e38e08610b38b875287d39cf54b3b520181b2ed7f761d",
  },
  // Filled in once the template is published on mainnet.
  mainnet: { indexer: "https://indexer-a.ootle.tari.com", template: null },
  localnet: { indexer: "http://127.0.0.1:12008", template: null },
};

export interface RepoConfig {
  network: NetworkName;
  jar: string;
  /** Optional stealth address for private tips that skip the jar. */
  stealth?: string;
}

export interface Jar {
  address: string;
  template: string;
  repo: string;
  shares: { account: string; bps: number }[];
  balance: bigint;
  tipCount: bigint;
  totalTipped: bigint;
  totalPaid: bigint;
}

/** Reads `key = "value"` lines. That is all `.github/ootip.toml` needs. */
export function parseConfig(text: string): RepoConfig {
  const kv: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z_]+)\s*=\s*"([^"]*)"$/);
    if (m) kv[m[1]] = m[2];
  }
  const network = (kv.network ?? "mainnet") as NetworkName;
  if (!(network in NETWORKS)) throw new Error(`unknown network "${network}" in ootip.toml`);
  if (!/^component_[0-9a-f]{64}$/.test(kv.jar ?? "")) throw new Error("ootip.toml has no valid jar = \"component_…\" line");
  return { network, jar: kv.jar, stealth: kv.stealth || undefined };
}

export function configToml(c: RepoConfig): string {
  const lines = [
    "# Ootip tip jar for this repository: https://geiserx.github.io/ootip/",
    `network = "${c.network}"`,
    `jar = "${c.jar}"`,
  ];
  if (c.stealth) lines.push(`stealth = "${c.stealth}"`);
  return lines.join("\n") + "\n";
}

export async function fetchConfig(repo: string, fetcher = fetch): Promise<RepoConfig> {
  const res = await fetcher(`https://raw.githubusercontent.com/${repo}/HEAD/.github/ootip.toml`);
  if (res.status === 404) throw new Error(`${repo} has no .github/ootip.toml yet`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  return parseConfig(await res.text());
}

function asBig(x: Cbor): bigint {
  if (typeof x !== "bigint") throw new Error("expected an integer in the jar state");
  return x;
}

/** Decodes a component substate (the indexer's base64 CBOR) into a Jar. */
export function decodeJar(address: string, substateB64: string): Jar {
  const root = decode(base64ToBytes(substateB64));
  // Component substate: [variant, [[header, [state]]]]; header[0] is the template address.
  const body = (root as Cbor[])[1] as Cbor[];
  const [header, wrapped] = body[0] as Cbor[];
  const template = "template_" + bytesToHex((header as Cbor[])[0] as Uint8Array);
  const state = (wrapped as Cbor[])[0] as Cbor[];
  if (!Array.isArray(state) || state.length !== 6 || typeof state[0] !== "string") {
    throw new Error("this component is not an Ootip jar");
  }
  const shares = (state[1] as Cbor[]).map((s) => {
    const [acc, bps] = s as [Tagged, bigint];
    return { account: "component_" + bytesToHex(acc.value as Uint8Array), bps: Number(bps) };
  });
  const totalTipped = asBig(state[4]);
  const totalPaid = asBig(state[5]);
  return {
    address,
    template,
    repo: state[0] as string,
    shares,
    // The vault only grows by tips and only shrinks by payouts.
    balance: totalTipped - totalPaid,
    tipCount: asBig(state[3]),
    totalTipped,
    totalPaid,
  };
}

export async function fetchJar(network: NetworkName, address: string, fetcher = fetch): Promise<Jar> {
  const res = await fetcher(`${NETWORKS[network].indexer}/substates/${address}`);
  if (res.status === 404) throw new Error(`jar ${address} does not exist on ${network}`);
  if (!res.ok) throw new Error(`the ${network} indexer answered ${res.status}`);
  const body = await res.json();
  const substate = body?.state?.up?.substate;
  if (!substate) throw new Error(`jar ${address} has been removed on ${network}`);
  return decodeJar(address, substate);
}

/** True when the jar is our template and names this repo. Case-insensitive, like GitHub. */
export function verify(jar: Jar, repo: string, network: NetworkName): { repoMatches: boolean; officialTemplate: boolean | null } {
  const expected = NETWORKS[network].template;
  return {
    repoMatches: jar.repo.toLowerCase() === repo.toLowerCase(),
    officialTemplate: expected ? jar.template === expected : null,
  };
}

/** 1 TARI = 1,000,000 µT. */
export function formatTari(ut: bigint): string {
  const whole = ut / 1_000_000n;
  const frac = (ut % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function parseTari(s: string): bigint {
  const m = s.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error("enter an amount like 5 or 0.25");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
