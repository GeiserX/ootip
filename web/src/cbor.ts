// SPDX-License-Identifier: MIT
// The small slice of CBOR that Ootle uses for call arguments and component state.
// Encoding matches @tari-project/ootle's cbor-literal helpers (checked in test/cbor.test.ts).

export type Arg = { Literal: string } | { Workspace: { id: number; offset: number | null } };

const TAG_COMPONENT = 128;
const TAG_RESOURCE = 131;

function head(out: number[], major: number, n: bigint): void {
  if (n < 24n) out.push(major | Number(n));
  else if (n < 0x100n) out.push(major | 24, Number(n));
  else if (n < 0x10000n) out.push(major | 25, Number(n >> 8n), Number(n & 0xffn));
  else if (n < 0x100000000n) {
    out.push(major | 26);
    for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  } else {
    out.push(major | 27);
    for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  }
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");

function addressBytes(address: string, prefix: string): number[] {
  const body = address.startsWith(prefix) ? address.slice(prefix.length) : address;
  if (!/^[0-9a-f]{64}$/.test(body)) throw new Error(`not a ${prefix.slice(0, -1)} address: ${address}`);
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(body.slice(i, i + 2), 16));
  return out;
}

function encUint(out: number[], v: bigint) {
  if (v < 0n || v >= 1n << 64n) throw new Error(`integer out of range: ${v}`);
  head(out, 0x00, v);
}

function encText(out: number[], s: string) {
  const bytes = [...new TextEncoder().encode(s)];
  head(out, 0x60, BigInt(bytes.length));
  out.push(...bytes);
}

function encTagged(out: number[], tag: number, bytes: number[]) {
  head(out, 0xc0, BigInt(tag));
  head(out, 0x40, BigInt(bytes.length));
  out.push(...bytes);
}

export const lit = {
  /** An Amount or any unsigned integer that fits 64 bits. */
  uint: (v: bigint | number): Arg => {
    const o: number[] = [];
    encUint(o, BigInt(v));
    return { Literal: hex(o) };
  },
  text: (s: string): Arg => {
    const o: number[] = [];
    encText(o, s);
    return { Literal: hex(o) };
  },
  component: (a: string): Arg => {
    const o: number[] = [];
    encTagged(o, TAG_COMPONENT, addressBytes(a, "component_"));
    return { Literal: hex(o) };
  },
  resource: (a: string): Arg => {
    const o: number[] = [];
    encTagged(o, TAG_RESOURCE, addressBytes(a, "resource_"));
    return { Literal: hex(o) };
  },
  components: (as: string[]): Arg => {
    const o: number[] = [];
    head(o, 0x80, BigInt(as.length));
    for (const a of as) encTagged(o, TAG_COMPONENT, addressBytes(a, "component_"));
    return { Literal: hex(o) };
  },
  uints: (vs: (bigint | number)[]): Arg => {
    const o: number[] = [];
    head(o, 0x80, BigInt(vs.length));
    for (const v of vs) encUint(o, BigInt(v));
    return { Literal: hex(o) };
  },
};

// ---- decoding

export type Cbor = bigint | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | Tagged | boolean | null;
export class Tagged {
  tag: number;
  value: Cbor;
  constructor(tag: number, value: Cbor) {
    this.tag = tag;
    this.value = value;
  }
}

export function decode(bytes: Uint8Array): Cbor {
  let i = 0;
  const uint = (info: number): bigint => {
    if (info < 24) return BigInt(info);
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (len < 0) throw new Error(`unsupported CBOR length ${info}`);
    let v = 0n;
    for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i++]);
    return v;
  };
  const item = (): Cbor => {
    const b = bytes[i++];
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return uint(info);
      case 1:
        return -1n - uint(info);
      case 2: {
        const n = Number(uint(info));
        const v = bytes.slice(i, i + n);
        i += n;
        return v;
      }
      case 3: {
        const n = Number(uint(info));
        const v = new TextDecoder().decode(bytes.slice(i, i + n));
        i += n;
        return v;
      }
      case 4: {
        const n = Number(uint(info));
        return Array.from({ length: n }, item);
      }
      case 5: {
        const n = Number(uint(info));
        const m = new Map<Cbor, Cbor>();
        for (let k = 0; k < n; k++) m.set(item(), item());
        return m;
      }
      case 6: {
        const tag = Number(uint(info));
        const v = item();
        // RFC 8949 tag 2: unsigned bignum, used for Amounts above u64.
        if (tag === 2 && v instanceof Uint8Array) return v.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
        return new Tagged(tag, v);
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error(`unsupported CBOR simple value ${info}`);
    }
    throw new Error("bad CBOR");
  };
  return item();
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
