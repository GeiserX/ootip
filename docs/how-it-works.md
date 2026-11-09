# How it works

## The template

[`template/src/lib.rs`](../template/src/lib.rs) is one Ootle template, `TipJar`. A jar is a component with this state:

| Field | What it holds |
|---|---|
| `repo` | `owner/name` of the repository the jar is for |
| `shares` | up to 16 `(account, bps)` pairs that add up to 10,000 |
| `vault` | the TARI waiting to be paid out |
| `tip_count`, `total_tipped`, `total_paid` | running totals, so the balance is `total_tipped - total_paid` |

| Method | Who can call it | What it does |
|---|---|---|
| `new(repo, accounts, bps)` | anyone | creates a jar; the signer becomes its owner |
| `tip(bucket, note)` | anyone | adds TARI to the jar; `note` (at most 253 bytes) goes into a public `Tip` event |
| `distribute()` | anyone | pays each account `balance × bps / 10,000`, rounded down; the last share also gets the rounding dust; the jar ends empty |
| `set_shares(accounts, bps)` | owner only | replaces the split; it does not pay out first, so put `distribute` before it in the same transaction to settle the old split |
| `info()` | anyone | returns the state above |

The split arrives as two lists, not a list of pairs, because the Ootle transaction manifest cannot write tuples.
Every check (empty split, a zero share, a duplicate account, more than 16 people, a sum other than 10,000,
mismatched list lengths) rejects the transaction before anything moves.

## The link between a repo and its jar

Anyone can create a jar that names any repo, so the jar alone proves nothing. The repo commits
`.github/ootip.toml`:

```toml
network = "esmeralda"   # or "mainnet"
jar = "component_…"
```

Only people with write access can commit that file. The page reads it from
`raw.githubusercontent.com/<owner>/<repo>/HEAD/.github/ootip.toml`, loads the jar from the network's public
indexer, and shows a tip form only when both hold:

- the jar's `repo` field is this repository (case-insensitive, like GitHub);
- the jar was created from the published Ootip template, so its code is the code in this repository.

The page code that does these checks is [`web/src/jar.ts`](../web/src/jar.ts).

## What is public

Ootle's native TARI is a stealth resource: transfers between private outputs hide the amount and the
receiver. A component's vault is not private, though. Depositing into one goes through a revealed (public)
output. So for Ootip, all of this is public:

- the jar's balance, every tip's amount and the split
- the note on a tip
- which account signed the tip transaction

## Known limits

- Amounts in a jar are public. That is how component vaults work on Ootle today.
- A direct private tip to one maintainer (a stealth payment, amount and receiver hidden) is not in this version.
  With the Sapient wallet the sender has to hand the payment's commitment to the receiver out of band, which a
  static page cannot do well.
- Maintainers need an Ootle account address. GitHub logins are not mapped to accounts; the split suggestion
  fills in the shares and leaves the addresses to the jar's creator.
- Tips come from your public balance. Sapient 0.9.4 has a request kind, `withdrawStealthAndExecute`, that
  sounds like it would pay a tip from private funds. In 0.9.4 it withdraws from the account's public balance
  instead, so the page doesn't offer it.
- The page talks to wallets that inject `window.tari`. Tipping and paying out work with Sapient 0.9.4 from the
  Chrome Web Store on Esmeralda (tested 2026-11-09). Sapient 0.6.17, built from its GitHub source, can't: it
  still builds the transaction format from before Ootle 0.50, and Esmeralda rejects it. The mainnet template
  address is filled in once it is published there.
