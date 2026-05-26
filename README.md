# Unstake NFTs · Admin tool

Static one-pager for force-unstaking every NFT from a VeChain staking pool. Two buttons, one wallet signature per action, no backend.

## What it does

1. **Grant OPERATOR_ROLE** on a staking pool to a recovery contract and an operator wallet (one multi-clause transaction).
2. **Loop `recoverERC721fromStaked(0, batch, staking, nft)`** on the recovery contract until the pool's NFT balance hits zero. Each batch is one signature.

The script auto-shifts to single-NFT calls when fewer than 50 are left to avoid the known off-by-one bug in `recoverERC721fromStaked` (see `PLAYBOOK.md` in the upstream kit).

## Requirements

- VeChain mainnet
- VeWorld browser extension (injects `window.connex`)
- The connected wallet must hold `DEFAULT_ADMIN` on the staking pool for Step 1
- The recovery contract must hold `OPERATOR_ROLE` on the staking pool for Step 2 (Step 1 grants this)

## Run locally

Open `index.html` in a browser with VeWorld installed. No build, no install.

## Deploy on GitHub Pages

Push to a public repo. In repo settings → Pages → Source = `main` branch, `/ (root)` folder. Site goes live at `https://<user>.github.io/<repo>/`.

## Files

```
unstake-NFTs/
├── index.html   page layout, inputs, buttons, log
├── style.css    dark + lime palette, single-column responsive
├── app.js       Connex wiring: connect, grantRole, recovery loop
└── README.md    this file
```

## Default config (editable from the UI)

| Field | Value |
| --- | --- |
| Staking pool | `0x964add004ab4784473a4a7fe90e4f4a0dd39b2e8` |
| NFT collection | `0x61d6e954b90d6506ce6964682744bfc2d51abebd` |
| Recovery contract | `0x7adfec6382b2ee4ab9e8248b2f735937e52b43ee` |
| Operator wallet | `0xeDF0a6C58658aBe4E2dF3E3B193d9D2CD443599a` |
| Batch size | 25 |

## Safety notes

- The connect step is a `cert` signature only. No funds move.
- Step 1 emits one multi-clause `grantRole` tx. Wallet shows both clauses before signing.
- Step 2 emits one tx per batch. The Stop button takes effect after the in-flight batch completes — it does not cancel a pending signature.
- All operations are visible on chain. The log shows every `txid`. Cross-check on `vechainstats.com` if anything looks off.
