<h1 align="center">Ootip</h1>

<p align="center">
  <a href="https://github.com/GeiserX/ootip/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GeiserX/ootip/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GeiserX/ootip?style=flat-square" alt="License"></a>
  <a href="https://geiserx.github.io/ootip/#/GeiserX/ootip"><img src="https://geiserx.github.io/ootip/badge.svg" alt="Tip on Tari"></a>
</p>

Ootip is a tip jar for open-source repositories, built as a template on [Tari Ootle](https://ootle.tari.com/).
Anyone can tip a repo in TARI, and one call pays every maintainer their share of the jar, so the jar never sits on
the money. A repo proves the jar is its own with one committed file, so there is no server and no sign-up.

Try it on the Esmeralda testnet: https://geiserx.github.io/ootip/#/GeiserX/ootip

## Features

- One jar per repository, with up to 16 maintainers and a split in basis points (10,000 = the whole jar)
- `tip` and `distribute` are open to anyone; only the jar's owner can change the split
- Payouts round down per share and give the dust to the last share, so the jar always ends empty
- `.github/ootip.toml` links the repo to its jar; only someone with write access can commit it
- The page checks both directions: the file names the jar, and the jar names the repo and runs the Ootip template
- Split suggestion from GitHub commit counts, bots left out
- Tip and pay out through a `window.tari` wallet such as Sapient
- A static page (18 KB of JavaScript) on GitHub Pages; it reads the public indexer and never holds keys

## Quick start

Make a jar for your repo at https://geiserx.github.io/ootip/#/new, then commit the two files it prints:

```toml
# .github/ootip.toml
network = "esmeralda"
jar = "component_…"
```

```yaml
# .github/FUNDING.yml
custom: ["https://geiserx.github.io/ootip/#/<owner>/<repo>"]
```

GitHub then shows a Sponsor button that opens your jar. To build and test the template yourself, see [Development](docs/development.md).

## Documentation

- [How it works](docs/how-it-works.md): the template, the link file, what is public
- [Development](docs/development.md): build, unit tests, the end-to-end run on a local network or the testnet
- [Known limits](docs/how-it-works.md#known-limits)

## License

[MIT](LICENSE)
