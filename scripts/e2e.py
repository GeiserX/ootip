#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""End-to-end check of the Ootip jar on a real Ootle network, through a wallet daemon.

It publishes the template (or reuses --template), creates a jar that splits 70/30 between two
maintainer accounts, tips it from a third account, has the tipper call `distribute`, and checks
every balance on the way. It also checks that a stranger cannot change the split.

    scripts/e2e.py --wallet-url http://127.0.0.1:12010/json_rpc            # localnet swarm
    scripts/e2e.py --wallet-url http://127.0.0.1:5100/json_rpc --template template_…  # testnet

The wallet daemon must accept `auth.request` with `None` credentials (swarm default), or pass
--token. It needs only the standard library.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / "template"
WASM = TEMPLATE_DIR / "target" / "wasm32-unknown-unknown" / "release" / "ootip_jar.wasm"
TARI_TOKEN = "resource_" + "01" * 32
TARI = 1_000_000  # microtari
TEMPLATE_RE = re.compile(r"^template_[0-9a-f]{64}$")
COMPONENT_RE = re.compile(r"^component_[0-9a-f]{64}$")


class Failed(Exception):
    pass


class Wallet:
    def __init__(self, url, token=None):
        self.url, self.token, self._id, self.at = url, token, 0, 0.0
        if not token:
            self.login()

    def login(self):
        self.token = None
        self.token = self.call("auth.request", {"permissions": ["Admin"], "credentials": "None"})["token"]
        self.at = time.monotonic()

    def call(self, method, params=None, timeout=180):
        if self.at and method != "auth.request" and time.monotonic() - self.at > 240:
            self.login()
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
        if payload.get("error"):
            raise Failed(f"{method}: {payload['error'].get('message')} {json.dumps(payload['error'].get('data'))}")
        return payload["result"]

    def wait(self, tx_id, expect_accept=True):
        res = self.call("transactions.wait_result", {"transaction_id": tx_id, "timeout_secs": 120}, timeout=160)
        if res.get("timed_out"):
            raise Failed(f"{tx_id} timed out")
        accepted = res.get("status") == "Accepted"
        if accepted != expect_accept:
            raise Failed(f"{tx_id} finished as {res.get('status')}: {reason(res)}")
        return res

    def account(self, name):
        return self.call("accounts.create_or_get", {"account": {"Name": name}})["account"]

    def tari(self, name):
        res = self.call("accounts.get_balances", {"account": {"Name": name}, "refresh": True})
        for b in res.get("balances", []):
            if b.get("resource_address") == TARI_TOKEN:
                return int(b.get("balance") or 0)
        return 0


def reason(res):
    text = json.dumps(res)
    m = re.search(r'"(?:Reject|reason|AcceptFeeRejectRest)"[^"]*"([^"]{0,300})', text)
    return m.group(1) if m else text[:400]


def strings(obj, pattern):
    out = []
    if isinstance(obj, str):
        if pattern.match(obj):
            out.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            out += strings(k, pattern) + strings(v, pattern)
    elif isinstance(obj, list):
        for v in obj:
            out += strings(v, pattern)
    return list(dict.fromkeys(out))


def fee_main(account_var="payer", amount=TARI):
    return f'fn fee_main() {{\n    let payer = var!["{account_var}"];\n    payer.pay_fee({amount});\n}}'


def manifest(wallet, signer, text, variables, expect_accept=True, max_fee=TARI):
    res = wallet.call("transactions.submit_manifest", {
        "manifest": text,
        "variables": variables,
        "seal_signer_key_id": signer["owner_key_id"],
        "signing_key_ids": [],
        "max_fee": max_fee,
        "dry_run": False,
        "blobs": {},
    })
    return res["transaction_id"], wallet.wait(res["transaction_id"], expect_accept)


def step(msg):
    print(f"-- {msg}", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wallet-url", default="http://127.0.0.1:12010/json_rpc")
    p.add_argument("--token")
    p.add_argument("--template", help="reuse a published template address instead of publishing")
    p.add_argument("--repo", default="GeiserX/ootip")
    p.add_argument("--prefix", default="ootip-e2e", help="account name prefix in the wallet")
    p.add_argument("--faucet", action="store_true", help="claim test coins (localnet/testnet only)")
    p.add_argument("--seed", type=int, default=0, help="TARI the owner sends to each other test account")
    args = p.parse_args()

    w = Wallet(args.wallet_url, args.token)
    owner, a, b, tipper, stranger = (w.account(f"{args.prefix}-{n}") for n in ("owner", "maint-a", "maint-b", "tipper", "stranger"))
    log = {"network_wallet": args.wallet_url, "accounts": {}}
    for n, acc in (("owner", owner), ("maint-a", a), ("maint-b", b), ("tipper", tipper), ("stranger", stranger)):
        log["accounts"][n] = acc["component_address"]

    if args.faucet:
        for n in ("owner", "maint-a", "maint-b", "tipper", "stranger"):
            if w.tari(f"{args.prefix}-{n}") < 5 * TARI:
                step(f"faucet -> {n}")
                res = w.call("accounts.create_free_test_coins", {"account": {"Name": f"{args.prefix}-{n}"}, "max_fee": 100_000}, timeout=240)
                w.wait(res["transaction_id"])

    if args.seed:
        # One funded owner pays for the rest; a transfer to a public key also creates the account.
        for n, acc in (("maint-a", a), ("maint-b", b), ("tipper", tipper), ("stranger", stranger)):
            if w.tari(f"{args.prefix}-{n}") < args.seed * TARI // 2:
                step(f"seed {args.seed} TARI -> {n}")
                res = w.call("accounts.transfer", {
                    "account": {"Name": f"{args.prefix}-owner"},
                    "amount": args.seed * TARI,
                    "resource_address": TARI_TOKEN,
                    "destination_public_key": acc["owner_public_key"],
                    "max_fee": TARI,
                    "proof_from_badge_resource": None,
                    "dry_run": False,
                })
                w.wait(res["transaction_id"])

    template = args.template
    if not template:
        step("build")
        subprocess.run(["tari", "build"], cwd=TEMPLATE_DIR, check=True, stdout=subprocess.DEVNULL)
        size = WASM.stat().st_size
        step(f"publish ({size} bytes)")
        res = w.call("transactions.publish_template", {
            "binary": base64.b64encode(WASM.read_bytes()).decode(),
            "fee_account": {"Name": f"{args.prefix}-owner"},
            "max_fee": 2 * TARI,
            "detect_inputs": True,
            "dry_run": False,
        })
        done = w.wait(res["transaction_id"])
        found = strings(done.get("result"), TEMPLATE_RE)
        if not found:
            raise Failed("publish accepted but no template address in the result")
        template = found[0]
        log["publish_tx"] = res["transaction_id"]
        log["wasm_bytes"] = size
    log["template"] = template
    step(f"template {template}")

    v = {"payer": owner["component_address"], "a": a["component_address"], "b": b["component_address"]}
    step("create jar 70/30")
    tx, done = manifest(w, owner, f'''use {template} as TipJar;
{fee_main()}
fn main() {{
    let jar = TipJar::new("{args.repo}", [var!["a"], var!["b"]], [7000u16, 3000u16]);
}}''', v)
    jars = [c for c in strings(done.get("result"), COMPONENT_RE) if c not in v.values()]
    if not jars:
        raise Failed("jar creation accepted but no new component in the result")
    jar = jars[0]
    log["create_tx"], log["jar"] = tx, jar
    step(f"jar {jar}")

    before_a, before_b = w.tari(f"{args.prefix}-maint-a"), w.tari(f"{args.prefix}-maint-b")
    tip = 1_001_001  # 1.001001 TARI, so the 70/30 split has rounding to show
    step(f"tip {tip} uT")
    tx, _ = manifest(w, tipper, f'''{fee_main()}
fn main() {{
    let tipper = var!["payer"];
    let jar = var!["jar"];
    let coins = tipper.withdraw(var!["tari"], {tip});
    jar.tip(coins, "thanks for the release");
}}''', {"payer": tipper["component_address"], "jar": jar, "tari": TARI_TOKEN})
    log["tip_tx"] = tx

    step("stranger tries set_shares (must be rejected)")
    try:
        tx, _ = manifest(w, stranger, f'''{fee_main()}
fn main() {{
    let jar = var!["jar"];
    jar.set_shares([var!["payer"]], [10000u16]);
}}''', {"payer": stranger["component_address"], "jar": jar}, expect_accept=False)
        log["stranger_set_shares_tx"] = tx
    except Failed as e:
        # A rejected call that still paid its fee is the expected outcome too.
        if "AcceptFeeRejectRest" not in str(e) and "Rejected" not in str(e):
            raise
        log["stranger_set_shares"] = "rejected"

    step("tipper calls distribute")
    tx, _ = manifest(w, tipper, f'''{fee_main()}
fn main() {{
    let jar = var!["jar"];
    jar.distribute();
}}''', {"payer": tipper["component_address"], "jar": jar})
    log["distribute_tx"] = tx

    got_a = w.tari(f"{args.prefix}-maint-a") - before_a
    got_b = w.tari(f"{args.prefix}-maint-b") - before_b
    want_a = tip * 7000 // 10000
    want_b = tip - want_a
    log["paid"] = {"maint-a": got_a, "maint-b": got_b}
    print(json.dumps(log, indent=2))
    if (got_a, got_b) != (want_a, want_b):
        raise Failed(f"payout {got_a}/{got_b}, expected {want_a}/{want_b}")
    print(f"OK: tip of {tip} uT paid out as {got_a} + {got_b}")


if __name__ == "__main__":
    try:
        main()
    except Failed as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
