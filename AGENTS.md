# AGENTS.md

Ootip: a tip jar template for Tari Ootle (`template/`), a static page (`web/`), and an end-to-end script
(`scripts/e2e.py`). Read `docs/how-it-works.md` and `docs/development.md` first.

- The template moves funds. Every change to `template/src/lib.rs` needs a test in `template/tests/jar.rs`, and
  `cargo test` must pass.
- The page's CBOR encoding must keep matching `@tari-project/ootle` (`web/test/web.test.ts`).
- After publishing the template on a network, update `NETWORKS` in `web/src/jar.ts`.
- Publishing a template or sending a transaction costs fees and cannot be undone: never do it on mainnet unasked.
- Conventional commits.
