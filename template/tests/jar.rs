// SPDX-License-Identifier: MIT
use tari_template_lib::{
    prelude::TARI_TOKEN,
    types::{Amount, ComponentAddress, NonFungibleAddress},
};
use tari_template_test_tooling::{
    TemplateTest,
    crypto::RistrettoSecretKey,
    support::assert_error::assert_reject_reason,
    transaction::args,
};

const TEMPLATE: &str = "TipJar";
const REPO: &str = "GeiserX/ootip";

struct Tipper {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
}

fn accounts(shares: &[(ComponentAddress, u16)]) -> Vec<ComponentAddress> {
    shares.iter().map(|s| s.0).collect()
}

fn bps(shares: &[(ComponentAddress, u16)]) -> Vec<u16> {
    shares.iter().map(|s| s.1).collect()
}

fn tipper(test: &mut TemplateTest) -> Tipper {
    let (account, proof, key) = test.create_funded_account();
    Tipper { account, proof, key }
}

fn create_jar(test: &mut TemplateTest, shares: Vec<(ComponentAddress, u16)>) -> ComponentAddress {
    let template = test.get_template_address(TEMPLATE);
    test.execute_expect_success(
        test.transaction()
            .call_function(template, "new", args![REPO, accounts(&shares), bps(&shares)])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    let mut jars = test
        .read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap();
    jars.pop().unwrap().0
}

fn create_jar_fails(test: &mut TemplateTest, repo: &str, shares: Vec<(ComponentAddress, u16)>, reason: &str) {
    let template = test.get_template_address(TEMPLATE);
    let rejected = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args![repo, accounts(&shares), bps(&shares)])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    assert_reject_reason(rejected, reason);
}

fn tip(test: &mut TemplateTest, from: &Tipper, jar: ComponentAddress, amount: u64, note: &str) {
    test.execute_expect_success(
        test.transaction()
            .call_method(from.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("tip")
            .call_method(jar, "tip", args![Workspace("tip"), note])
            .build_and_seal(&from.key),
        vec![from.proof.clone()],
    );
}

fn distribute(test: &mut TemplateTest, caller: &Tipper, jar: ComponentAddress) {
    test.execute_expect_success(
        test.transaction()
            .call_method(jar, "distribute", args![])
            .build_and_seal(&caller.key),
        vec![],
    );
}

fn tari(test: &TemplateTest, account: ComponentAddress) -> Amount {
    test.read_only_state_store()
        .get_vaults_for_account(account)
        .unwrap()
        .get(&TARI_TOKEN)
        .map(|v| v.balance())
        .unwrap_or_default()
}

fn jar_balance(test: &TemplateTest, jar: ComponentAddress) -> Amount {
    let vaults = test.read_only_state_store().get_vaults_for_component(jar).unwrap();
    vaults.values().next().map(|v| v.balance()).unwrap_or_default()
}

fn maintainers(test: &mut TemplateTest, n: usize) -> Vec<ComponentAddress> {
    (0..n).map(|_| test.create_empty_account().0).collect()
}

#[test]
fn tips_are_paid_out_by_share_and_the_jar_ends_empty() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 2);
    let jar = create_jar(&mut test, vec![(m[0], 7000), (m[1], 3000)]);
    let alice = tipper(&mut test);
    let bob = tipper(&mut test);

    tip(&mut test, &alice, jar, 600, "thanks for the release");
    tip(&mut test, &bob, jar, 401, "");
    assert_eq!(jar_balance(&test, jar), Amount::from(1001u64));

    // Anyone can trigger the payout, not just the owner or a maintainer.
    distribute(&mut test, &bob, jar);

    // 70% of 1001 rounds down to 700; the last share takes the remaining 301.
    assert_eq!(tari(&test, m[0]), Amount::from(700u64));
    assert_eq!(tari(&test, m[1]), Amount::from(301u64));
    assert_eq!(jar_balance(&test, jar), Amount::zero());

    let tip_count: u64 = test.extract_component_value(jar, "$.3");
    let total_tipped: Amount = test.extract_component_value(jar, "$.4");
    let total_paid: Amount = test.extract_component_value(jar, "$.5");
    assert_eq!(tip_count, 2);
    assert_eq!(total_tipped, Amount::from(1001u64));
    assert_eq!(total_paid, Amount::from(1001u64));
}

#[test]
fn rounding_dust_goes_to_the_last_share_and_zero_shares_are_skipped() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 3);
    let jar = create_jar(&mut test, vec![(m[0], 3333), (m[1], 3333), (m[2], 3334)]);
    let alice = tipper(&mut test);

    tip(&mut test, &alice, jar, 2, "");
    distribute(&mut test, &alice, jar);

    // 2 * 3333 / 10000 rounds to 0 for the first two, so the last one gets both.
    assert_eq!(tari(&test, m[0]), Amount::zero());
    assert_eq!(tari(&test, m[1]), Amount::zero());
    assert_eq!(tari(&test, m[2]), Amount::from(2u64));
    assert_eq!(jar_balance(&test, jar), Amount::zero());
}

#[test]
fn distributing_an_empty_jar_does_nothing() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 1);
    let jar = create_jar(&mut test, vec![(m[0], 10_000)]);
    let alice = tipper(&mut test);

    distribute(&mut test, &alice, jar);
    assert_eq!(tari(&test, m[0]), Amount::zero());
    let total_paid: Amount = test.extract_component_value(jar, "$.5");
    assert_eq!(total_paid, Amount::zero());
}

#[test]
fn only_the_owner_can_change_the_split() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 2);
    let jar = create_jar(&mut test, vec![(m[0], 10_000)]);
    let mallory = tipper(&mut test);

    let rejected = test.execute_expect_failure(
        test.transaction()
            .call_method(jar, "set_shares", args![vec![mallory.account], vec![10_000u16]])
            .build_and_seal(&mallory.key),
        vec![mallory.proof.clone()],
    );
    assert_reject_reason(rejected, "Access Denied");

    test.execute_expect_success(
        test.transaction()
            .call_method(jar, "set_shares", args![vec![m[0], m[1]], vec![5000u16, 5000u16]])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );

    let alice = tipper(&mut test);
    tip(&mut test, &alice, jar, 100, "");
    distribute(&mut test, &alice, jar);
    assert_eq!(tari(&test, m[0]), Amount::from(50u64));
    assert_eq!(tari(&test, m[1]), Amount::from(50u64));
    assert_eq!(tari(&test, mallory.account), Amount::from(TemplateTest::FUNDED_ACCOUNT_INITIAL_BALANCE));
}

#[test]
fn a_bad_split_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 17);

    create_jar_fails(&mut test, REPO, vec![], "at least one recipient is needed");
    create_jar_fails(&mut test, REPO, vec![(m[0], 6000), (m[1], 3000)], "shares must add up to 10000 bps");
    create_jar_fails(&mut test, REPO, vec![(m[0], 10_000), (m[1], 0)], "every share must be more than zero");
    create_jar_fails(&mut test, REPO, vec![(m[0], 5000), (m[0], 5000)], "a recipient appears twice");

    let seventeen: Vec<_> = m.iter().map(|a| (*a, 1u16)).collect();
    create_jar_fails(&mut test, REPO, seventeen, "at most 16 recipients");

    create_jar_fails(&mut test, "", vec![(m[0], 10_000)], "repo must be 1 to 140 bytes");

    let template = test.get_template_address(TEMPLATE);
    let rejected = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args![REPO, vec![m[0], m[1]], vec![10_000u16]])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    assert_reject_reason(rejected, "accounts and bps must be the same length");
    create_jar_fails(&mut test, "no-slash", vec![(m[0], 10_000)], "repo must be owner/name");
}

#[test]
fn set_shares_checks_the_split_too() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 2);
    let jar = create_jar(&mut test, vec![(m[0], 10_000)]);

    let rejected = test.execute_expect_failure(
        test.transaction()
            .call_method(jar, "set_shares", args![vec![m[0], m[1]], vec![9000u16, 9000u16]])
            .build_and_seal(test.secret_key()),
        vec![test.owner_proof()],
    );
    assert_reject_reason(rejected, "shares must add up to 10000 bps");
}

#[test]
fn a_long_note_is_rejected_and_nothing_moves() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 1);
    let jar = create_jar(&mut test, vec![(m[0], 10_000)]);
    let alice = tipper(&mut test);

    let note = "x".repeat(254);
    let rejected = test.execute_expect_failure(
        test.transaction()
            .call_method(alice.account, "withdraw", args![TARI_TOKEN, 100u64])
            .put_last_instruction_output_on_workspace("tip")
            .call_method(jar, "tip", args![Workspace("tip"), note])
            .build_and_seal(&alice.key),
        vec![alice.proof.clone()],
    );
    assert_reject_reason(rejected, "note must be at most 253 bytes");
    assert_eq!(jar_balance(&test, jar), Amount::zero());
    assert_eq!(tari(&test, alice.account), Amount::from(TemplateTest::FUNDED_ACCOUNT_INITIAL_BALANCE));
}

#[test]
fn info_reports_the_jar() {
    let mut test = TemplateTest::my_crate();
    let m = maintainers(&mut test, 1);
    let jar = create_jar(&mut test, vec![(m[0], 10_000)]);
    let alice = tipper(&mut test);
    tip(&mut test, &alice, jar, 42, "");

    test.execute_expect_success(
        test.transaction()
            .call_method(jar, "info", args![])
            .build_and_seal(&alice.key),
        vec![],
    );
    let (repo, shares, balance, count, tipped, paid): (
        String,
        Vec<(ComponentAddress, u16)>,
        Amount,
        u64,
        Amount,
        Amount,
    ) = test.return_values()[0].decoded().unwrap();
    assert_eq!(repo, REPO);
    assert_eq!(shares, vec![(m[0], 10_000)]);
    assert_eq!(balance, Amount::from(42u64));
    assert_eq!((count, tipped, paid), (1, Amount::from(42u64), Amount::zero()));
}
