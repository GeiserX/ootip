// SPDX-License-Identifier: MIT
import "./style.css";
import { configToml, fetchConfig, fetchJar, formatTari, NETWORKS, parseTari, verify, type Jar, type NetworkName } from "./jar";
import { suggestSplit, TOTAL_BPS, MAX_RECIPIENTS } from "./split";
import * as wallet from "./wallet";

const app = document.getElementById("app")!;
const SITE = "https://geiserx.github.io/ootip/";
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a: string) => `${a.slice(0, 14)}…${a.slice(-6)}`;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector(sel) as T;

let connected: { account: string; network: string; caps: Record<string, boolean> } | null = null;

function status(el: HTMLElement, text: string, kind: "info" | "ok" | "err" = "info") {
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function ensureWallet(statusEl: HTMLElement, network: NetworkName) {
  if (!connected) {
    status(statusEl, "Connecting to your wallet…");
    await wallet.waitForProvider();
    connected = await wallet.connect();
  }
  if (connected.network !== network) {
    throw new Error(`Your wallet is on ${connected.network}, this jar is on ${network}. Switch networks in the wallet.`);
  }
  return connected;
}

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (hash === "new" || hash.startsWith("new?")) return renderCreate(new URLSearchParams(hash.split("?")[1] ?? "").get("repo") ?? "");
  if (REPO_RE.test(hash)) return renderJar(hash);
  return renderHome();
}

// ---- home

function renderHome() {
  app.innerHTML = `
    <section class="hero">
      <h1>Tip jars for open-source repos</h1>
      <p>Anyone can tip a repository in TARI. One click pays every maintainer their share,
      so the jar never holds the money. Runs on <a href="https://ootle.tari.com/">Tari Ootle</a>.</p>
      <form id="find" class="row">
        <input id="repo" placeholder="owner/repo" autocomplete="off" spellcheck="false" required />
        <button>Open jar</button>
      </form>
      <p class="muted">Maintainer? <a href="#/new">Create a jar for your repo</a>.</p>
    </section>
    <section class="steps">
      <div><b>1. Create</b><p>Make a jar on-chain with the split between your maintainers, in basis points. Ootip can suggest one from commit counts.</p></div>
      <div><b>2. Link</b><p>Commit <code>.github/ootip.toml</code> naming the jar. Only someone with write access can, so that file is the proof the jar is yours.</p></div>
      <div><b>3. Get tipped</b><p>Add the page to your <code>FUNDING.yml</code>. Tips land in the jar; anyone can pay it out to the maintainers.</p></div>
    </section>
    <section class="note">
      <b>What is private and what is not.</b> A jar's balance, each tip's amount and the split are public.
      A tip paid from your private balance does not reveal which of your coins paid for it, or how much you hold.
      The note on a tip is public, so leave it empty for anything personal.
    </section>`;
  $<HTMLFormElement>("#find").onsubmit = (e) => {
    e.preventDefault();
    const repo = $<HTMLInputElement>("#repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    location.hash = `#/${repo}`;
  };
}

// ---- a repo's jar

async function renderJar(repo: string) {
  app.innerHTML = `<p class="muted">Loading the jar for <b>${esc(repo)}</b>…</p>`;
  let jar: Jar, network: NetworkName;
  try {
    const cfg = await fetchConfig(repo);
    network = cfg.network;
    jar = await fetchJar(network, cfg.jar);
  } catch (e) {
    app.innerHTML = `
      <h2>${esc(repo)}</h2>
      <p class="status err">${esc((e as Error).message)}</p>
      <p>If this is your repository, <a href="#/new?repo=${encodeURIComponent(repo)}">create a jar for it</a>.</p>`;
    return;
  }
  const v = verify(jar, repo, network);
  const badges = [
    v.repoMatches ? `<span class="ok">✓ linked from ${esc(repo)}</span>` : `<span class="bad">✗ the jar names ${esc(jar.repo)}, not this repo</span>`,
    v.officialTemplate === null ? `<span class="warn">template not checked on ${network}</span>`
      : v.officialTemplate ? `<span class="ok">✓ Ootip template</span>` : `<span class="bad">✗ not the Ootip template</span>`,
  ].join(" ");
  const safe = v.repoMatches && v.officialTemplate !== false;
  const rows = jar.shares
    .map((s) => `<tr><td><code title="${s.account}">${short(s.account)}</code></td><td>${(s.bps / 100).toFixed(2)}%</td></tr>`)
    .join("");

  app.innerHTML = `
    <h2><a href="https://github.com/${esc(repo)}">${esc(repo)}</a> <span class="net">${network}</span></h2>
    <p class="badges">${badges}</p>
    <div class="stats">
      <div><span>${formatTari(jar.balance)}</span>TARI waiting</div>
      <div><span>${jar.tipCount}</span>tips</div>
      <div><span>${formatTari(jar.totalTipped)}</span>TARI tipped</div>
      <div><span>${formatTari(jar.totalPaid)}</span>TARI paid out</div>
    </div>
    <h3>Split</h3>
    <table class="split"><tr><th>Maintainer account</th><th>Share</th></tr>${rows}</table>
    <h3>Tip</h3>
    <form id="tip" class="tip">
      <input id="amount" inputmode="decimal" placeholder="Amount in TARI" required ${safe ? "" : "disabled"} />
      <input id="note" maxlength="253" placeholder="Public note (optional)" ${safe ? "" : "disabled"} />
      <div class="row">
        <button data-mode="public" ${safe ? "" : "disabled"}>Tip</button>
        <button data-mode="private" class="alt" ${safe ? "" : "disabled"}>Tip from private balance</button>
      </div>
    </form>
    <p><button id="payout" class="alt" ${jar.balance > 0n ? "" : "disabled"}>Pay out ${formatTari(jar.balance)} TARI to the maintainers</button></p>
    <p id="status" class="status"></p>
    <p class="muted">Jar <code>${jar.address}</code></p>`;

  const st = $("#status");
  let mode = "public";
  app.querySelectorAll<HTMLButtonElement>("#tip button").forEach((b) => (b.onclick = () => (mode = b.dataset.mode!)));
  $<HTMLFormElement>("#tip").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const amount = parseTari($<HTMLInputElement>("#amount").value);
      if (amount <= 0n) throw new Error("A tip must be more than zero.");
      const note = $<HTMLInputElement>("#note").value;
      if (new TextEncoder().encode(note).length > 253) throw new Error("The note can be at most 253 bytes.");
      const w = await ensureWallet(st, network);
      if (mode === "private" && w.caps.stealthWithdraw === false) {
        throw new Error("This wallet account cannot pay from a private balance. Use a local account, or tip from your public balance.");
      }
      status(st, "Approve the tip in your wallet…");
      if (mode === "private") await wallet.tipFromPrivate(jar.address, amount, note);
      else await wallet.tipPublic(w.account, jar.address, amount, note);
      status(st, `Thank you. ${formatTari(amount)} TARI is in the jar.`, "ok");
      setTimeout(() => renderJar(repo), 2500);
    } catch (err) {
      status(st, (err as Error).message, "err");
    }
  };
  $<HTMLButtonElement>("#payout").onclick = async () => {
    try {
      await ensureWallet(st, network);
      status(st, "Approve the payout in your wallet…");
      await wallet.distribute(jar.address);
      status(st, "Paid out to the maintainers.", "ok");
      setTimeout(() => renderJar(repo), 2500);
    } catch (err) {
      status(st, (err as Error).message, "err");
    }
  };
}

// ---- create a jar

function renderCreate(prefill: string) {
  app.innerHTML = `
    <h2>Create a jar</h2>
    <form id="create">
      <label>Repository <input id="repo" placeholder="owner/repo" value="${esc(prefill)}" required spellcheck="false" /></label>
      <label>Network
        <select id="network">${(Object.keys(NETWORKS) as NetworkName[])
          .filter((n) => NETWORKS[n].template)
          .map((n) => `<option>${n}</option>`)
          .join("")}</select>
      </label>
      <h3>Split <button type="button" id="suggest" class="alt small">Suggest from commits</button></h3>
      <p class="muted">Each maintainer needs an Ootle account address (<code>component_…</code>). Shares are in basis points: 10,000 is the whole jar, up to ${MAX_RECIPIENTS} people.</p>
      <table class="split" id="rows"><tr><th>Who</th><th>Account</th><th>bps</th><th></th></tr></table>
      <p><button type="button" id="add" class="alt small">Add a maintainer</button> <span id="sum" class="muted"></span></p>
      <button>Create the jar</button>
    </form>
    <p id="status" class="status"></p>
    <div id="done"></div>`;
  const rows = $("#rows");
  const sum = $("#sum");
  const st = $("#status");
  const addRow = (who = "", account = "", bps: number | string = "") => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input class="who" value="${esc(who)}" placeholder="name" /></td>
      <td><input class="acc" value="${esc(account)}" placeholder="component_…" spellcheck="false" /></td>
      <td><input class="bps" value="${esc(String(bps))}" inputmode="numeric" /></td>
      <td><button type="button" class="alt small">✕</button></td>`;
    tr.querySelector("button")!.onclick = () => (tr.remove(), total());
    tr.querySelector<HTMLInputElement>(".bps")!.oninput = total;
    rows.appendChild(tr);
    total();
  };
  function total() {
    const t = [...app.querySelectorAll<HTMLInputElement>(".bps")].reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    sum.textContent = `${t} / ${TOTAL_BPS} bps`;
    sum.className = t === TOTAL_BPS ? "ok" : "muted";
  }
  addRow("", connected?.account ?? "", TOTAL_BPS);
  $("#add").onclick = () => addRow();
  $("#suggest").onclick = async () => {
    const repo = $<HTMLInputElement>("#repo").value.trim();
    try {
      status(st, "Reading commit counts from GitHub…");
      const s = await suggestSplit(repo);
      if (!s.length) throw new Error("GitHub lists no contributors for that repo.");
      rows.querySelectorAll("tr:not(:first-child)").forEach((r) => r.remove());
      s.forEach((c) => addRow(c.login, "", c.bps));
      status(st, `Split by ${s.reduce((a, c) => a + c.commits, 0)} commits. Fill in each person's Ootle account, or drop rows and rebalance.`, "ok");
    } catch (err) {
      status(st, (err as Error).message, "err");
    }
  };
  $<HTMLFormElement>("#create").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const repo = $<HTMLInputElement>("#repo").value.trim();
      if (!REPO_RE.test(repo)) throw new Error("Write the repository as owner/repo.");
      const network = $<HTMLSelectElement>("#network").value as NetworkName;
      const trs = [...rows.querySelectorAll("tr:not(:first-child)")];
      const accounts = trs.map((tr) => tr.querySelector<HTMLInputElement>(".acc")!.value.trim());
      const bps = trs.map((tr) => parseInt(tr.querySelector<HTMLInputElement>(".bps")!.value, 10));
      if (!accounts.length || accounts.length > MAX_RECIPIENTS) throw new Error(`Add 1 to ${MAX_RECIPIENTS} maintainers.`);
      if (accounts.some((a) => !/^component_[0-9a-f]{64}$/.test(a))) throw new Error("Every row needs an account address that starts with component_.");
      if (new Set(accounts).size !== accounts.length) throw new Error("A maintainer appears twice.");
      if (bps.some((b) => !(b > 0 && b <= TOTAL_BPS))) throw new Error("Every share must be at least 1 bps.");
      if (bps.reduce((a, b) => a + b, 0) !== TOTAL_BPS) throw new Error(`Shares must add up to ${TOTAL_BPS} bps.`);
      const w = await ensureWallet(st, network);
      status(st, "Approve the new jar in your wallet…");
      const jar = await wallet.createJar(NETWORKS[network].template!, repo, accounts, bps, w.account);
      status(st, "Your jar exists. Two commits left:", "ok");
      showLinkSteps(repo, network, jar);
    } catch (err) {
      status(st, (err as Error).message, "err");
    }
  };
}

function showLinkSteps(repo: string, network: NetworkName, jar: string) {
  const page = `${SITE}#/${repo}`;
  $("#done").innerHTML = `
    <h3>1. Link the jar: <code>.github/ootip.toml</code></h3>
    <pre>${esc(configToml({ network, jar }))}</pre>
    <h3>2. Show a Sponsor button: <code>.github/FUNDING.yml</code></h3>
    <pre>custom: ["${esc(page)}"]</pre>
    <h3>Optional: a README badge</h3>
    <pre>${esc(`[![Tip on Tari](${SITE}badge.svg)](${page})`)}</pre>
    <p>After the first commit, <a href="#/${esc(repo)}">open your jar's page</a>.</p>`;
}

window.addEventListener("hashchange", route);
window.addEventListener("tari#accountsChanged", () => (connected = null));
route();
