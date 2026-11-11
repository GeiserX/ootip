// SPDX-License-Identifier: MIT
// Talks to any wallet that injects the EIP-1193-style `window.tari` provider (Sapient and others).
import { lit, type Arg } from "./cbor";

export const TARI_TOKEN = "resource_" + "01".repeat(32);
const MAX_FEE = "2000000"; // 2 TARI cap; real fees are a few hundred µT

type Instruction = Record<string, unknown> | string;

interface Provider {
  isTariWallet?: boolean;
  request(args: { method: string; params?: unknown }): Promise<any>;
}

declare global {
  interface Window {
    tari?: Provider;
  }
}

export function provider(): Provider | null {
  return window.tari?.request ? window.tari : null;
}

export function waitForProvider(ms = 1500): Promise<Provider | null> {
  if (provider()) return Promise.resolve(provider());
  return new Promise((resolve) => {
    const done = () => resolve(provider());
    window.addEventListener("tari#initialized", done, { once: true });
    setTimeout(done, ms);
  });
}

function need(): Provider {
  const p = provider();
  if (!p) throw new Error("No Tari wallet found. Install a wallet that provides window.tari, such as Sapient.");
  return p;
}

export async function connect(): Promise<{ account: string; network: string }> {
  const p = need();
  const [account] = await p.request({ method: "tari_requestAccounts" });
  const network = await p.request({ method: "tari_getNetwork" });
  return { account, network };
}

/** Asks the wallet to move to another network; resolves to the network it is on afterwards. */
export async function switchNetwork(network: string): Promise<string> {
  const p = need();
  await p.request({ method: "tari_switchNetwork", params: { network } });
  return p.request({ method: "tari_getNetwork" });
}

// ---- instruction builders (the raw shape the provider takes)

const callMethod = (component: string, method: string, args: Arg[]): Instruction => ({
  CallMethod: { call: { Address: component }, method, args },
});
const callFunction = (template: string, fn: string, args: Arg[]): Instruction => ({
  CallFunction: { address: template.replace(/^template_/, ""), function: fn, args },
});
const putOnWorkspace = (key: number): Instruction => ({ PutLastInstructionOutputOnWorkspace: { key } });
const workspace = (id: number): Arg => ({ Workspace: { id, offset: null } });

export function tipInstructions(account: string, jar: string, amount: bigint, note: string): Instruction[] {
  return [
    callMethod(account, "withdraw", [lit.resource(TARI_TOKEN), lit.uint(amount)]),
    putOnWorkspace(0),
    callMethod(jar, "tip", [workspace(0), lit.text(note)]),
  ];
}

export function distributeInstructions(jar: string): Instruction[] {
  return [callMethod(jar, "distribute", [])];
}

export function createJarInstructions(template: string, repo: string, accounts: string[], bps: number[]): Instruction[] {
  return [callFunction(template, "new", [lit.text(repo), lit.components(accounts), lit.uints(bps)])];
}

// ---- submit through the create / approve / submit flow

async function submit(operation: Record<string, unknown>): Promise<any> {
  const p = need();
  const { requestId } = await p.request({ method: "tari_createTransactionRequest", params: operation });
  for (;;) {
    const r = await p.request({ method: "tari_getTransactionRequest", params: { requestId } });
    if (r.status === "approved") return p.request({ method: "tari_submitTransactionRequest", params: { requestId } });
    if (r.status === "submitted") return r.result;
    if (r.status === "rejected" || r.status === "failed") throw new Error(r.error ?? `Transaction ${r.status}.`);
    await new Promise((res) => setTimeout(res, 700));
  }
}

/** A tip from the account's public balance. */
export function tipPublic(account: string, jar: string, amount: bigint, note: string) {
  return submit({ kind: "instructions", instructions: tipInstructions(account, jar, amount, note), maxFee: MAX_FEE });
}

export function distribute(jar: string) {
  return submit({ kind: "instructions", instructions: distributeInstructions(jar), maxFee: MAX_FEE });
}

export async function createJar(template: string, repo: string, accounts: string[], bps: number[], signer: string): Promise<string> {
  const result = await submit({
    kind: "instructions",
    instructions: createJarInstructions(template, repo, accounts, bps),
    maxFee: MAX_FEE,
  });
  const found = JSON.stringify(result).match(/component_[0-9a-f]{64}/g) ?? [];
  const jar = found.find((c) => c !== signer && !accounts.includes(c));
  if (!jar) throw new Error("The jar was created but its address was not in the result. Check the transaction in your wallet.");
  return jar;
}
