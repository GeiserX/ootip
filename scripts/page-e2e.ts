// SPDX-License-Identifier: MIT
// Sends the exact instructions the web page builds (web/src/wallet.ts) to a real network through a wallet
// daemon, then reads the jar back the way the page does (web/src/jar.ts). Run with Bun:
//
//   bun scripts/page-e2e.ts --wallet-url http://127.0.0.1:5100/json_rpc --network esmeralda --prefix ootip
//
// It uses the accounts scripts/e2e.py created (<prefix>-owner, -maint-a, -maint-b, -tipper); run that first.
import { createJarInstructions, distributeInstructions, tipInstructions } from "../web/src/wallet";
import { fetchJar, NETWORKS, verify, type NetworkName } from "../web/src/jar";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const url = arg("wallet-url", "http://127.0.0.1:5100/json_rpc");
const network = arg("network", "esmeralda") as NetworkName;
const prefix = arg("prefix", "ootip");
if (!(network in NETWORKS)) throw new Error(`unknown --network ${network}; use one of ${Object.keys(NETWORKS).join(", ")}`);
const template = arg("template", NETWORKS[network].template ?? "");
if (!/^template_[0-9a-f]{64}$/.test(template)) {
  throw new Error(`no Ootip template is known on ${network}; pass --template template_…`);
}

let id = 0;
let token: string | null = null;
async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? "")}`);
  return body.result;
}

async function send(feeAccount: string, instructions: unknown[]) {
  const { transaction_id } = await rpc("transactions.submit_instruction", {
    instructions,
    fee_account: { Name: feeAccount },
    max_fee: 2_000_000,
    inputs: [],
    override_inputs: true,
    proof_ids: [],
  });
  const done = await rpc("transactions.wait_result", { transaction_id, timeout_secs: 120 });
  if (done.status !== "Accepted") throw new Error(`${transaction_id} ${done.status}: ${JSON.stringify(done.result).slice(0, 400)}`);
  return { transaction_id, done };
}

const account = async (n: string) => (await rpc("accounts.create_or_get", { account: { Name: `${prefix}-${n}` } })).account;
const tari = async (n: string) => {
  const r = await rpc("accounts.get_balances", { account: { Name: `${prefix}-${n}` }, refresh: true });
  return BigInt(r.balances.find((b: any) => b.resource_address === "resource_" + "01".repeat(32))?.balance ?? 0);
};

token = (await rpc("auth.request", { permissions: ["Admin"], credentials: "None" })).token;
const [owner, a, b, tipper] = await Promise.all(["owner", "maint-a", "maint-b", "tipper"].map(account));
const repo = "GeiserX/ootip";

console.log("-- create jar 6000/4000 with createJarInstructions()");
const created = await send(`${prefix}-owner`, createJarInstructions(template, repo, [a.component_address, b.component_address], [6000, 4000]));
const jar = (JSON.stringify(created.done.result).match(/component_[0-9a-f]{64}/g) ?? []).find(
  (c) => ![owner.component_address, a.component_address, b.component_address].includes(c),
);
if (!jar) throw new Error("no jar in the result");
console.log(`   jar ${jar}  tx ${created.transaction_id}`);

const beforeA = await tari("maint-a");
const beforeB = await tari("maint-b");
const amount = 2_500_003n;
console.log(`-- tip ${amount} uT with tipInstructions()`);
const tipped = await send(`${prefix}-tipper`, tipInstructions(tipper.component_address, jar, amount, "page e2e"));
console.log(`   tx ${tipped.transaction_id}`);

// Read it back exactly as the page does. The indexer can lag a moment behind finalisation.
// A lagging indexer may not serve the jar at all yet (404), or serve the version before the tip.
let seen: Awaited<ReturnType<typeof fetchJar>> | null = null;
for (let k = 0; k < 15 && !(seen && seen.tipCount > 0n); k++) {
  if (k) await new Promise((r) => setTimeout(r, 1500));
  try {
    seen = await fetchJar(network, jar);
  } catch (e) {
    if (k === 14) throw e;
  }
}
if (!seen) throw new Error("the indexer never served the jar");
console.log(`   page view: balance ${seen.balance}, tips ${seen.tipCount}, checks ${JSON.stringify(verify(seen, repo, network))}`);
if (seen.balance !== amount || seen.tipCount !== 1n) throw new Error("the page does not see the tip");

console.log("-- distribute with distributeInstructions()");
const paid = await send(`${prefix}-tipper`, distributeInstructions(jar));
console.log(`   tx ${paid.transaction_id}`);
const gotA = (await tari("maint-a")) - beforeA;
const gotB = (await tari("maint-b")) - beforeB;
const wantA = (amount * 6000n) / 10000n;
console.log(`   paid ${gotA} + ${gotB}`);
if (gotA !== wantA || gotB !== amount - wantA) throw new Error(`expected ${wantA} + ${amount - wantA}`);
console.log(`OK: the page's instructions created ${jar}, tipped it and paid out exactly.`);
