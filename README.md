# Unstake NFTs · Admin tool

Static one-pager to force-unstake every NFT from a VeChain staking pool. Direct `exit(tokenId)` calls, multi-clause batches. No backend, no build.

## What it does

For each NFT held by the staking pool:

1. Reads the next tokenId via `tokenOfOwnerByIndex(staking, 0)`.
2. Packs N `exit(tokenId)` calls into a single multi-clause transaction.
3. Signs once with VeWorld.
4. `exit()` sends the NFT back to its original `ticketOwner` (recorded in the staking contract's `tokenDetail`) and records pending reward in `rewards[tokenId]`.
5. Loops until the pool's NFT balance hits zero.

411 NFTs at batch size 20 → ~21 signed transactions instead of 411.

## Requirements

- VeChain mainnet (`https://mainnet.vechain.org`)
- VeWorld browser extension
- The connected wallet must hold `DEFAULT_ADMIN` (or `OPERATOR_ROLE`) on the staking pool — otherwise `exit()` reverts on the access-control check

## Flow

1. **Connect Wallet** — VeWorld cert sign, no funds move
2. **Test 1 NFT first** — single `exit()` on the first staked tokenId. If it confirms, the loop will too. If it reverts, fix permissions before going wide
3. **Start Unstaking** — loops multi-clause batches until the pool is empty. Stop button takes effect after the in-flight batch completes

## Run locally

```
open index.html
```

VeWorld extension auto-injects on file:// and any HTTPS site.

## Deploy on GitHub Pages or Vercel

Push to a public repo. On Vercel: import → framework "Other" → build command empty → output dir `.` → deploy.

## Default config (editable from the UI)

| Field | Value |
| --- | --- |
| Staking pool | `0x964add004ab4784473a4a7fe90e4f4a0dd39b2e8` (Female Goatz) |
| NFT collection | `0x61d6e954b90d6506ce6964682744bfc2d51abebd` |
| Batch size | 20 exits per signed transaction |

## Rewards (WoV)

`exit()` on this contract does NOT auto-transfer the pending WoV reward. It only records the amount in `rewards[tokenId]`. After the unstake loop completes:

- Top up the staking pool with enough WoV to cover the sum of pending rewards
- Each original staker can then call `getReward(tokenId)` to claim

The unstake tool only handles NFT recovery. Reward distribution is a separate operation.

## Files

```
unstake-NFTs/
├── index.html   page layout, inputs, buttons, log
├── style.css    dark + lime palette, single-column responsive
├── app.js       Connex/VeWorld wiring, exit() batches
└── README.md    this file
```
