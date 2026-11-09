# Development

## Layout

| Path | What |
|---|---|
| [`template/`](../template/) | the `TipJar` template (Rust, compiled to WASM) and its unit tests |
| [`web/`](../web/) | the static page (TypeScript, Vite) and its tests |
| [`scripts/e2e.py`](../scripts/e2e.py) | the end-to-end run against a real network through a wallet daemon |

## Template

```bash
rustup target add wasm32-unknown-unknown
cargo install tari-ootle-cli          # the `tari` command
cd template
cargo test                            # unit tests against the real Ootle engine
tari build                            # target/wasm32-unknown-unknown/release/ootip_jar.wasm
tari lint --deny-warnings --no-clippy
```

The tests use `tari_template_test_tooling`, which runs the template in the same engine the network uses.

## Web page

```bash
cd web
bun install
NODE_OPTIONS=--experimental-wasm-modules bun run test   # checks the encoder against @tari-project/ootle
bun run build                                           # dist/, served by GitHub Pages
bun run dev
```

The page has no runtime dependencies. `@tari-project/ootle` is a dev dependency only, used by the tests to
prove, in [`web/test/web.test.ts`](../web/test/web.test.ts), that the page's CBOR encoding of every argument matches the official SDK byte for byte.

## End to end on a real network

`scripts/e2e.py` needs only the Python standard library and a running `tari_ootle_walletd`. It creates five
accounts in the wallet (owner, two maintainers, a tipper and a stranger), publishes the template, creates a 70/30
jar, tips 1.001001 TARI, checks that the stranger cannot change the split, has the tipper call `distribute`, and
checks that the maintainers got exactly 700,700 and 300,301 µT.

Local network, with the swarm daemon from the
[tari-ootle releases](https://github.com/tari-project/tari-ootle/releases) (wallet daemon with `none` auth):

```bash
python3 scripts/e2e.py --wallet-url http://127.0.0.1:12010/json_rpc --faucet
```

Esmeralda testnet, with an owner account funded from a community faucet:

```bash
python3 scripts/e2e.py --wallet-url http://127.0.0.1:5100/json_rpc --prefix ootip --seed 20
```

`--template template_…` reuses a published template instead of publishing a new one.

[`scripts/page-e2e.ts`](../scripts/page-e2e.ts) then checks the page itself. It takes the instructions the
page builds in [`web/src/wallet.ts`](../web/src/wallet.ts), submits them unchanged through the wallet daemon's
`transactions.submit_instruction`, and reads the jar back with the page's own [`web/src/jar.ts`](../web/src/jar.ts):

```bash
bun scripts/page-e2e.ts --wallet-url http://127.0.0.1:5100/json_rpc --network esmeralda --prefix ootip
```

## Publishing the template

`tari publish` (or the wallet daemon's `transactions.publish_template`) costs a fee and cannot be undone. After
publishing on a network, put the template address in `NETWORKS` in [`web/src/jar.ts`](../web/src/jar.ts), so the page can tell an
Ootip jar from a look-alike.
