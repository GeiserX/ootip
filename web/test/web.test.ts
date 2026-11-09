// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  amountLiteral,
  componentAddressLiteral,
  intLiteral,
  resourceAddressLiteral,
  stringLiteral,
} from "@tari-project/ootle";
import { lit } from "../src/cbor";
import { configToml, decodeJar, formatTari, parseConfig, parseTari, verify, NETWORKS } from "../src/jar";
import { pickContributors, toBps } from "../src/split";
import { createJarInstructions, tipInstructions, TARI_TOKEN } from "../src/wallet";

const A = "component_" + "ab".repeat(32);
const B = "component_" + "0f".repeat(32);

describe("argument encoding matches the official SDK", () => {
  it.each([0n, 1n, 23n, 24n, 255n, 256n, 65_535n, 65_536n, 1_001_001n, 2n ** 32n, 2n ** 64n - 1n])("uint %s", (v) => {
    expect(lit.uint(v)).toEqual(amountLiteral(v));
    expect(lit.uint(v)).toEqual(intLiteral(v));
  });
  it.each(["", "GeiserX/ootip", "thanks for the release ✨", "x".repeat(253)])("text %j", (s) => {
    expect(lit.text(s)).toEqual(stringLiteral(s));
  });
  it("addresses", () => {
    expect(lit.component(A)).toEqual(componentAddressLiteral(A));
    expect(lit.resource(TARI_TOKEN)).toEqual(resourceAddressLiteral(TARI_TOKEN));
  });
  it("lists are a CBOR array head plus the encoded items", () => {
    const one = (x: unknown) => (x as { Literal: string }).Literal;
    expect(one(lit.components([A, B]))).toBe("82" + one(componentAddressLiteral(A)) + one(componentAddressLiteral(B)));
    expect(one(lit.uints([7000, 3000]))).toBe("82" + one(intLiteral(7000n)) + one(intLiteral(3000n)));
    expect(one(lit.uints([]))).toBe("80");
  });
  it("rejects a malformed address", () => {
    expect(() => lit.component("component_xyz")).toThrow();
  });
});

describe("transactions", () => {
  it("a tip withdraws from the tipper and hands the bucket to the jar", () => {
    const ins = tipInstructions(A, B, 5n, "hi") as any[];
    expect(ins[0].CallMethod.call).toEqual({ Address: A });
    expect(ins[0].CallMethod.method).toBe("withdraw");
    expect(ins[1]).toEqual({ PutLastInstructionOutputOnWorkspace: { key: 0 } });
    expect(ins[2].CallMethod).toMatchObject({ call: { Address: B }, method: "tip" });
    expect(ins[2].CallMethod.args[0]).toEqual({ Workspace: { id: 0, offset: null } });
  });
  it("create calls new on the template hash", () => {
    const [ins] = createJarInstructions("template_" + "cd".repeat(32), "o/r", [A], [10_000]) as any[];
    expect(ins.CallFunction.address).toBe("cd".repeat(32));
    expect(ins.CallFunction.function).toBe("new");
    expect(ins.CallFunction.args).toHaveLength(3);
  });
});

describe("reading a real jar", () => {
  // Fetched from the public Esmeralda indexer after scripts/e2e.py ran one 1.001001 TARI tip.
  const fixture = JSON.parse(readFileSync(new URL("./jar-substate.esmeralda.json", import.meta.url), "utf8"));
  const address = "component_a96d239533cd9db01255177cd950c7061cd65ffd7606a32748471b8a3d4849b1";
  const jar = decodeJar(address, fixture.state.up.substate);

  it("decodes repo, split and totals", () => {
    expect(jar.repo).toBe("GeiserX/ootip");
    expect(jar.template).toBe(NETWORKS.esmeralda.template);
    expect(jar.shares).toEqual([
      { account: "component_0087f275e48b15cdc812c442a07df833e8a33d178a44972289f56030e08b6b9e", bps: 7000 },
      { account: "component_9c8d2715114547246df3d541b3f88252b4d89cf98a667277b0ae5281510efaa3", bps: 3000 },
    ]);
    expect(jar.tipCount).toBe(1n);
    expect(jar.totalTipped).toBe(1_001_001n);
    expect(jar.totalPaid).toBe(1_001_001n);
    expect(jar.balance).toBe(0n);
  });
  it("verifies against the repo name, case-insensitively, and the template", () => {
    expect(verify(jar, "geiserx/OOTIP", "esmeralda")).toEqual({ repoMatches: true, officialTemplate: true });
    expect(verify(jar, "someone/else", "esmeralda").repoMatches).toBe(false);
    expect(verify({ ...jar, template: "template_" + "00".repeat(32) }, "GeiserX/ootip", "esmeralda").officialTemplate).toBe(false);
  });
});

describe("ootip.toml", () => {
  it("round-trips", () => {
    const c = { network: "esmeralda" as const, jar: A };
    expect(parseConfig(configToml(c))).toEqual({ ...c, stealth: undefined });
  });
  it("defaults to mainnet and ignores comments", () => {
    expect(parseConfig(`# hi\njar = "${A}"  # mine\n`).network).toBe("mainnet");
  });
  it("rejects a file without a jar, or an unknown network", () => {
    expect(() => parseConfig('network = "esmeralda"')).toThrow(/jar/);
    expect(() => parseConfig(`network = "nope"\njar = "${A}"`)).toThrow(/network/);
  });
});

describe("amounts", () => {
  it("formats and parses TARI", () => {
    expect(formatTari(1_001_001n)).toBe("1.001001");
    expect(formatTari(5_000_000n)).toBe("5");
    expect(parseTari("0.25")).toBe(250_000n);
    expect(parseTari("12")).toBe(12_000_000n);
    expect(() => parseTari("1.0000001")).toThrow();
    expect(() => parseTari("-1")).toThrow();
  });
});

describe("contributor split", () => {
  it("always adds up to 10,000 and gives everyone at least 1 bps", () => {
    for (const w of [[1], [1, 1, 1], [500, 3, 1], [1, 1, 1, 1, 1, 1, 1], Array.from({ length: 16 }, (_, i) => (i + 1) ** 3)]) {
      const bps = toBps(w);
      expect(bps.reduce((a, b) => a + b, 0)).toBe(10_000);
      expect(Math.min(...bps)).toBeGreaterThanOrEqual(1);
    }
    expect(toBps([3, 1])).toEqual([7500, 2500]);
    expect(toBps([1, 1, 1])).toEqual([3334, 3333, 3333]);
  });
  it("drops bots and keeps the top 16 by commits", () => {
    const list = [
      { login: "dependabot[bot]", type: "Bot", contributions: 900 },
      { login: "renovate", type: "Bot", contributions: 50 },
      ...Array.from({ length: 20 }, (_, i) => ({ login: `dev${i}`, type: "User", contributions: i + 1 })),
    ];
    const top = pickContributors(list);
    expect(top).toHaveLength(16);
    expect(top[0]).toEqual({ login: "dev19", commits: 20 });
    expect(top.some((c) => c.login.includes("bot") || c.login === "renovate")).toBe(false);
  });
});
