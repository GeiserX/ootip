// SPDX-License-Identifier: MIT
//! Ootip tip jar.
//!
//! One jar belongs to one open-source repository. Anyone can drop TARI into it with `tip`.
//! Anyone can call `distribute`, which pays every maintainer their share of the balance and
//! leaves the jar empty, so the jar never sits on the money. Only the jar's owner (the key that
//! created it) can change the split.
//!
//! What is public: the jar's balance, each tip's amount, and the split. What is not: a tip
//! funded from stealth outputs does not reveal which outputs paid for it.

use tari_template_lib::prelude::*;

#[template]
mod tip_jar {
    use super::*;

    /// Shares are in basis points: 10,000 bps is the whole jar.
    pub const TOTAL_BPS: u32 = 10_000;
    /// Keeps `distribute` cheap and inside the per-transaction limits.
    pub const MAX_RECIPIENTS: usize = 16;
    /// Same limit as a stealth output memo.
    pub const MAX_NOTE_BYTES: usize = 253;
    /// "owner/name" on GitHub is at most 39 + 1 + 100 bytes.
    pub const MAX_REPO_BYTES: usize = 140;

    pub struct TipJar {
        /// The repository this jar is for, as "owner/name". The repository proves the link back
        /// by naming this component in its `.github/ootip.toml`.
        repo: String,
        /// Who gets paid, and how much of each payout, in basis points.
        shares: Vec<(ComponentAddress, u16)>,
        vault: Vault,
        tip_count: u64,
        total_tipped: Amount,
        total_paid: Amount,
    }

    impl TipJar {
        /// Creates a jar for `repo` that pays `accounts[i]` a share of `bps[i]` basis points.
        ///
        /// The split comes as two lists so that every client, the transaction manifest included,
        /// can encode it. The signer of the creating transaction becomes the owner, the only one
        /// who can call `set_shares`.
        pub fn new(repo: String, accounts: Vec<ComponentAddress>, bps: Vec<u16>) -> Component<Self> {
            assert!(!repo.is_empty() && repo.len() <= MAX_REPO_BYTES, "repo must be 1 to 140 bytes");
            assert!(repo.split('/').count() == 2, "repo must be owner/name");
            let shares = zip_shares(accounts, bps);

            let access_rules = ComponentAccessRules::new()
                .method("tip", rule![allow_all])
                .method("distribute", rule![allow_all])
                .method("info", rule![allow_all]);

            Component::new(Self {
                repo,
                shares,
                vault: Vault::new_empty(TARI_TOKEN),
                tip_count: 0,
                total_tipped: Amount::zero(),
                total_paid: Amount::zero(),
            })
            .with_access_rules(access_rules)
            .create()
        }

        /// Adds a tip. `note` is public; leave it empty, or use a private stealth tip, for
        /// anything you would not post on a forum.
        pub fn tip(&mut self, tip: Bucket, note: String) {
            assert!(tip.resource_address() == TARI_TOKEN, "tips must be in TARI");
            let amount = tip.amount();
            assert!(amount.is_positive(), "tip must be more than zero");
            assert!(note.len() <= MAX_NOTE_BYTES, "note must be at most 253 bytes");

            self.vault.deposit(tip);
            self.tip_count += 1;
            self.total_tipped = self.total_tipped.saturating_add(amount);

            emit_event("Tip", metadata![
                "repo" => self.repo.clone(),
                "amount" => amount,
                "note" => note,
            ]);
        }

        /// Pays out the whole balance by the current shares and returns the amount paid.
        ///
        /// Every share is rounded down; the last recipient also receives the rounding dust, so
        /// the jar ends empty. A recipient whose share rounds to zero is skipped.
        pub fn distribute(&mut self) -> Amount {
            let balance = self.vault.balance();
            if balance.is_zero() {
                return Amount::zero();
            }

            let payouts = split(balance, &self.shares);
            for (account, amount) in payouts {
                let bucket = self.vault.withdraw(amount);
                ComponentManager::get(account).invoke("deposit", args![bucket]);
            }
            self.total_paid = self.total_paid.saturating_add(balance);

            emit_event("Distribute", metadata![
                "repo" => self.repo.clone(),
                "amount" => balance,
                "recipients" => self.shares.len(),
            ]);
            balance
        }

        /// Replaces the split. Owner only.
        ///
        /// It does not pay out first. To settle the old split, put `distribute` before this call
        /// in the same transaction.
        pub fn set_shares(&mut self, accounts: Vec<ComponentAddress>, bps: Vec<u16>) {
            self.shares = zip_shares(accounts, bps);
            emit_event("SetShares", metadata![
                "repo" => self.repo.clone(),
                "recipients" => self.shares.len(),
            ]);
        }

        /// Returns (repo, shares, balance, tip count, total tipped, total paid).
        pub fn info(&self) -> (String, Vec<(ComponentAddress, u16)>, Amount, u64, Amount, Amount) {
            (
                self.repo.clone(),
                self.shares.clone(),
                self.vault.balance(),
                self.tip_count,
                self.total_tipped,
                self.total_paid,
            )
        }
    }

    fn zip_shares(accounts: Vec<ComponentAddress>, bps: Vec<u16>) -> Vec<(ComponentAddress, u16)> {
        assert!(accounts.len() == bps.len(), "accounts and bps must be the same length");
        let shares: Vec<_> = accounts.into_iter().zip(bps).collect();
        check_shares(&shares);
        shares
    }

    fn check_shares(shares: &[(ComponentAddress, u16)]) {
        assert!(!shares.is_empty(), "at least one recipient is needed");
        assert!(shares.len() <= MAX_RECIPIENTS, "at most 16 recipients");
        let mut total: u32 = 0;
        for (i, (account, bps)) in shares.iter().enumerate() {
            assert!(*bps > 0, "every share must be more than zero");
            assert!(
                !shares[..i].iter().any(|(other, _)| other == account),
                "a recipient appears twice"
            );
            total += u32::from(*bps);
        }
        assert!(total == TOTAL_BPS, "shares must add up to 10000 bps");
    }

    /// Splits `balance` by `shares`. Each share rounds down; the last one takes the remainder.
    /// Zero amounts are left out. The amounts always add up to `balance`.
    fn split(balance: Amount, shares: &[(ComponentAddress, u16)]) -> Vec<(ComponentAddress, Amount)> {
        let total = balance.to_u128();
        let mut paid: u128 = 0;
        let mut out = Vec::with_capacity(shares.len());
        let last = shares.len() - 1;
        for (i, (account, bps)) in shares.iter().enumerate() {
            let amount = if i == last {
                total - paid
            } else {
                total * u128::from(*bps) / u128::from(TOTAL_BPS)
            };
            paid += amount;
            if amount > 0 {
                out.push((*account, Amount::from(amount)));
            }
        }
        out
    }
}
