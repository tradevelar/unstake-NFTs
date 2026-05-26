// Unstake NFTs admin tool — vanilla JS, Connex-based.
//
// Drives two operations against a VeChain staking pool:
//   1. Grant OPERATOR_ROLE on the pool to a recovery contract + an
//      operator wallet (multi-clause, one signature).
//   2. Loop `recoverERC721fromStaked(0, batch, staking, nft)` on the
//      recovery contract until the staking pool is drained.
//
// Wallet: VeWorld extension. Requires `window.connex` to be injected.
// Network: VeChain mainnet (https://mainnet.vechain.org).

const OPERATOR_ROLE = '0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929'
const ADMIN_ROLE    = '0x0000000000000000000000000000000000000000000000000000000000000000'

// Minimal ABIs we need for asClause / call.
const ABI_GRANT_ROLE = {
  inputs: [
    { internalType: 'bytes32', name: 'role',    type: 'bytes32' },
    { internalType: 'address', name: 'account', type: 'address' },
  ],
  name: 'grantRole',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}

const ABI_HAS_ROLE = {
  inputs: [
    { internalType: 'bytes32', name: 'role',    type: 'bytes32' },
    { internalType: 'address', name: 'account', type: 'address' },
  ],
  name: 'hasRole',
  outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
  stateMutability: 'view',
  type: 'function',
}

const ABI_BALANCE_OF = {
  inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}

const ABI_RECOVER_BATCH = {
  inputs: [
    { internalType: 'uint256', name: 'start',   type: 'uint256' },
    { internalType: 'uint256', name: 'size',    type: 'uint256' },
    { internalType: 'address', name: 'staking', type: 'address' },
    { internalType: 'address', name: 'nft',     type: 'address' },
  ],
  name: 'recoverERC721fromStaked',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}

// Per-token exit on the recovery contract. The batch function has a
// documented off-by-one at i=0 (Panic 0x32) when remaining is small,
// so we fall through to callExit individually once remaining < 50.
const ABI_CALL_EXIT = {
  inputs: [
    { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
    { internalType: 'address', name: 'staking', type: 'address' },
  ],
  name: 'callExit',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}

const ABI_TOKEN_OF_OWNER_BY_INDEX = {
  inputs: [
    { internalType: 'address', name: 'owner', type: 'address' },
    { internalType: 'uint256', name: 'index', type: 'uint256' },
  ],
  name: 'tokenOfOwnerByIndex',
  outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}

const CALLEXIT_THRESHOLD = 50

// State
const state = {
  signer: null,
  stopRequested: false,
  running: false,
}

// ──────────────────────────────────────────────────────────────────────
// DOM
// ──────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const els = {
  staking:     $('stakingInput'),
  nft:         $('nftInput'),
  recovery:    $('recoveryInput'),
  operator:    $('operatorInput'),
  batch:       $('batchInput'),
  walletState: $('walletState'),
  connectBtn:  $('connectBtn'),
  grantBtn:    $('grantBtn'),
  grantStatus: $('grantStatus'),
  unstakeBtn:  $('unstakeBtn'),
  stopBtn:     $('stopBtn'),
  refreshBtn:  $('refreshBtn'),
  progressBar:  $('progressBar'),
  progressText: $('progressText'),
  progressPct:  $('progressPct'),
  log:         $('log'),
}

function log(line, cls = '') {
  const time = new Date().toTimeString().slice(0, 8)
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = `[${time}] ${line}\n`
  // Replace the [idle] placeholder on first real log.
  if (els.log.textContent === '[idle]') els.log.textContent = ''
  els.log.appendChild(span)
  els.log.scrollTop = els.log.scrollHeight
}

function setProgress(current, total) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  els.progressBar.style.width = pct + '%'
  els.progressText.textContent = `${current} / ${total}`
  els.progressPct.textContent = pct + '%'
}

function setGrantStatus(text, cls = '') {
  els.grantStatus.textContent = text
  els.grantStatus.className = 'status ' + cls
}

function lockInputsForRun(locked) {
  ['staking', 'nft', 'recovery', 'operator', 'batch'].forEach((k) => {
    els[k].disabled = locked
  })
  els.grantBtn.disabled = locked || !state.signer
  els.unstakeBtn.disabled = locked || !state.signer
  $('testOneBtn').disabled = locked || !state.signer
  els.connectBtn.disabled = locked
  els.stopBtn.disabled = !locked
}

// ──────────────────────────────────────────────────────────────────────
// Connex helpers
// ──────────────────────────────────────────────────────────────────────

function getConnex() {
  if (!window.connex || !window.connex.thor || !window.connex.vendor) {
    throw new Error('VeWorld extension not detected. Install VeWorld and reload this page.')
  }
  return window.connex
}

async function readBalanceOf(tokenAddr, holder) {
  const connex = getConnex()
  const method = connex.thor.account(tokenAddr).method(ABI_BALANCE_OF)
  const r = await method.call(holder)
  return BigInt(r.decoded[0])
}

async function readHasRole(contractAddr, role, account) {
  const connex = getConnex()
  const method = connex.thor.account(contractAddr).method(ABI_HAS_ROLE)
  const r = await method.call(role, account)
  return Boolean(r.decoded[0])
}

async function signClauses(clauses, comment) {
  const connex = getConnex()
  let signing = connex.vendor.sign('tx', clauses)
  if (state.signer) signing = signing.signer(state.signer)
  if (comment) signing = signing.comment(comment)
  return signing.request()
}

async function waitForReceipt(txid, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  const connex = getConnex()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await connex.thor.transaction(txid).getReceipt()
    if (r) return r
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  throw new Error(`receipt timeout after ${timeoutMs}ms for tx ${txid}`)
}

// ──────────────────────────────────────────────────────────────────────
// Wallet
// ──────────────────────────────────────────────────────────────────────

async function connectWallet() {
  try {
    const connex = getConnex()
    const cert = {
      purpose: 'identification',
      payload: { type: 'text', content: 'Sign in to Unstake NFTs admin tool' },
    }
    const r = await connex.vendor.sign('cert', cert).request()
    state.signer = r.annex.signer
    els.walletState.innerHTML = `Connected as <code class="lime">${state.signer}</code>`
    els.walletState.classList.remove('muted')
    els.grantBtn.disabled = false
    els.unstakeBtn.disabled = false
    $('testOneBtn').disabled = false
    log(`Wallet connected: ${state.signer}`, 'ok')
  } catch (err) {
    log(`Connect failed: ${err.message}`, 'err')
  }
}

// ──────────────────────────────────────────────────────────────────────
// Step 1 — Grant OPERATOR_ROLE
// ──────────────────────────────────────────────────────────────────────

async function grantOperatorRoles() {
  if (!state.signer) return
  const staking  = els.staking.value.trim()
  const recovery = els.recovery.value.trim()
  const operator = els.operator.value.trim()

  if (!staking || !recovery || !operator) {
    setGrantStatus('Fill all three addresses first.', 'error')
    return
  }

  setGrantStatus('Checking current roles...')
  log(`Checking OPERATOR_ROLE on staking ${staking}...`, 'info')

  let needRecovery = true, needOperator = true
  try {
    needRecovery = !(await readHasRole(staking, OPERATOR_ROLE, recovery))
    needOperator = !(await readHasRole(staking, OPERATOR_ROLE, operator))
  } catch (err) {
    log(`hasRole probe failed (will grant unconditionally): ${err.message}`, 'err')
  }

  if (!needRecovery && !needOperator) {
    setGrantStatus('Both addresses already have OPERATOR_ROLE. Nothing to do.', 'ok')
    log('Both addresses already operator. Skipping.', 'ok')
    return
  }

  // Sanity: connected wallet must hold DEFAULT_ADMIN on staking pool.
  try {
    const isAdmin = await readHasRole(staking, ADMIN_ROLE, state.signer)
    if (!isAdmin) {
      const msg = 'Connected wallet does not hold DEFAULT_ADMIN on the staking pool. Cannot grant roles.'
      setGrantStatus(msg, 'error')
      log(msg, 'err')
      return
    }
  } catch (err) {
    log(`Admin role probe failed: ${err.message}`, 'err')
  }

  const connex = getConnex()
  const method = connex.thor.account(staking).method(ABI_GRANT_ROLE)
  const clauses = []
  if (needRecovery) clauses.push(method.asClause(OPERATOR_ROLE, recovery))
  if (needOperator) clauses.push(method.asClause(OPERATOR_ROLE, operator))

  setGrantStatus(`Awaiting signature for ${clauses.length} grantRole clause(s)...`)
  log(`Submitting grantRole × ${clauses.length}...`, 'info')

  try {
    const r = await signClauses(clauses, 'Grant OPERATOR_ROLE on staking pool')
    log(`Tx submitted: ${r.txid}`, 'lime')
    setGrantStatus(`Waiting for confirmation... (${r.txid.slice(0, 10)}…)`)
    const receipt = await waitForReceipt(r.txid)
    if (receipt.reverted) {
      setGrantStatus('Transaction reverted. Check the connected wallet has DEFAULT_ADMIN on the pool.', 'error')
      log(`Grant reverted: ${r.txid}`, 'err')
    } else {
      setGrantStatus('Granted ✓ Recovery contract + operator wallet now have OPERATOR_ROLE.', 'ok')
      log(`Grant confirmed in block ${receipt.meta.blockNumber}`, 'ok')
    }
  } catch (err) {
    setGrantStatus(`Failed: ${err.message}`, 'error')
    log(`Grant failed: ${err.message}`, 'err')
  }
}

// ──────────────────────────────────────────────────────────────────────
// Step 2 — Unstake loop
// ──────────────────────────────────────────────────────────────────────

async function refreshBalance() {
  const staking = els.staking.value.trim()
  const nft     = els.nft.value.trim()
  if (!staking || !nft) return null
  try {
    const bal = await readBalanceOf(nft, staking)
    log(`Current NFT balance of staking pool: ${bal}`, 'info')
    setProgress(0, Number(bal))
    return Number(bal)
  } catch (err) {
    log(`balanceOf probe failed: ${err.message}`, 'err')
    return null
  }
}

async function readFirstStakedTokenId(nft, staking) {
  const connex = getConnex()
  const m = connex.thor.account(nft).method(ABI_TOKEN_OF_OWNER_BY_INDEX)
  const r = await m.call(staking, 0)
  return r.decoded[0]
}

async function testOneNFT() {
  if (!state.signer) return
  const staking  = els.staking.value.trim()
  const nft      = els.nft.value.trim()
  const recovery = els.recovery.value.trim()
  if (!staking || !nft || !recovery) {
    log('Fill staking + nft + recovery addresses first.', 'err')
    return
  }
  log('Test mode: pulling one NFT via callExit(tokenId, staking)...', 'lime')
  try {
    const tokenId = await readFirstStakedTokenId(nft, staking)
    log(`First staked tokenId: ${tokenId}`, 'info')
    const connex = getConnex()
    const method = connex.thor.account(recovery).method(ABI_CALL_EXIT)
    const clause = method.asClause(tokenId, staking)
    const r = await connex.vendor.sign('tx', [clause])
      .signer(state.signer)
      .gas(800000)
      .comment(`Test callExit(${tokenId}, ${staking.slice(0, 10)}…)`)
      .request()
    log(`Tx submitted: ${r.txid}`, 'lime')
    const receipt = await waitForReceipt(r.txid)
    if (receipt.reverted) {
      log(`Test reverted. exit() on this pool is NOT working as expected.`, 'err')
      log('Likely cause: internal staker mapping was cleared (totalSupply=0).', 'err')
      log('Try forceUnstake(address, tokenId) instead, or contact the contract owner.', 'err')
    } else {
      log(`Test passed ✓ NFT ${tokenId} returned to original staker in block ${receipt.meta.blockNumber}.`, 'ok')
      log('Safe to run the full unstake loop.', 'ok')
    }
    await refreshBalance()
  } catch (err) {
    log(`Test failed: ${err.message}`, 'err')
  }
}

async function startUnstake() {
  if (state.running) return
  if (!state.signer) return

  const staking   = els.staking.value.trim()
  const nft       = els.nft.value.trim()
  const recovery  = els.recovery.value.trim()
  const batchSize = parseInt(els.batch.value, 10)

  if (!staking || !nft || !recovery || !batchSize) {
    log('Fill all addresses + batch size first.', 'err')
    return
  }
  if (batchSize < 1 || batchSize > 50) {
    log('Batch size must be between 1 and 50.', 'err')
    return
  }

  state.running = true
  state.stopRequested = false
  lockInputsForRun(true)
  log(`==== Unstake loop started ====`, 'lime')
  log(`Staking pool: ${staking}`, 'info')
  log(`NFT:          ${nft}`, 'info')
  log(`Recovery:     ${recovery}`, 'info')
  log(`Batch size:   ${batchSize}`, 'info')

  let initial = await refreshBalance()
  if (initial == null) {
    log('Could not read initial balance. Aborting.', 'err')
    state.running = false
    lockInputsForRun(false)
    return
  }

  if (initial === 0) {
    log('Staking pool already empty. Nothing to do.', 'ok')
    state.running = false
    lockInputsForRun(false)
    return
  }

  const total = initial
  let batch = 1
  const connex = getConnex()
  const batchMethod = connex.thor.account(recovery).method(ABI_RECOVER_BATCH)
  const exitMethod  = connex.thor.account(recovery).method(ABI_CALL_EXIT)

  while (!state.stopRequested) {
    const remaining = await readBalanceOf(nft, staking).then(Number)
    if (remaining === 0) {
      log('Staking pool drained. ✓', 'ok')
      break
    }

    // Two-mode strategy from the upstream playbook:
    //   remaining >= 50  → recoverERC721fromStaked in chunks of batchSize
    //   remaining <  50  → callExit per-token to dodge the off-by-one
    //                      Panic 0x32 in the batch function.
    const useBatch = remaining >= CALLEXIT_THRESHOLD
    const size = useBatch ? Math.min(batchSize, remaining) : 1
    const mode = useBatch ? 'batch' : 'callExit'
    const label = `Tx #${batch} · ${mode} · size ${size} · remaining ${remaining}`
    log(label, 'info')

    try {
      let clause, gas, comment, displayedAction
      if (useBatch) {
        clause = batchMethod.asClause(0, size, staking, nft)
        gas = 500000 + 250000 * size
        comment = `recoverERC721fromStaked(0, ${size}, ${staking.slice(0, 10)}…, ${nft.slice(0, 10)}…)`
        displayedAction = `batch of ${size}`
      } else {
        const tokenId = await readFirstStakedTokenId(nft, staking)
        clause = exitMethod.asClause(tokenId, staking)
        gas = 800000
        comment = `callExit(${tokenId}, ${staking.slice(0, 10)}…)`
        displayedAction = `tokenId ${tokenId}`
      }

      const r = await connex.vendor.sign('tx', [clause])
        .signer(state.signer)
        .gas(gas)
        .comment(comment)
        .request()
      log(`  tx (${displayedAction}): ${r.txid}`, 'lime')

      const receipt = await waitForReceipt(r.txid, { timeoutMs: 120000 })
      if (receipt.reverted) {
        log(`  ${label} reverted. Waiting 5s before retrying...`, 'err')
        await new Promise((res) => setTimeout(res, 5000))
      } else {
        const newRemaining = await readBalanceOf(nft, staking).then(Number)
        setProgress(total - newRemaining, total)
        log(`  confirmed in block ${receipt.meta.blockNumber}, remaining ${newRemaining}`, 'ok')
      }
    } catch (err) {
      if (err && err.message && err.message.toLowerCase().includes('cancel')) {
        log('User cancelled signature. Stopping.', 'err')
        break
      }
      log(`  step failed: ${err.message}. Waiting 5s and retrying...`, 'err')
      await new Promise((res) => setTimeout(res, 5000))
    }

    batch += 1
    // tiny pacing between txs to keep the UI smooth and avoid
    // hammering the RPC with back-to-back getReceipt loops.
    await new Promise((res) => setTimeout(res, 1500))
  }

  log(`==== Unstake loop finished (stopped=${state.stopRequested}) ====`, 'lime')
  state.running = false
  state.stopRequested = false
  lockInputsForRun(false)
  await refreshBalance()
}

function stopUnstake() {
  if (!state.running) return
  state.stopRequested = true
  log('Stop requested. Will exit after the in-flight batch.', 'err')
}

// ──────────────────────────────────────────────────────────────────────
// Wire up
// ──────────────────────────────────────────────────────────────────────

els.connectBtn.addEventListener('click', connectWallet)
els.grantBtn.addEventListener('click', grantOperatorRoles)
els.unstakeBtn.addEventListener('click', startUnstake)
els.stopBtn.addEventListener('click', stopUnstake)
els.refreshBtn.addEventListener('click', refreshBalance)
$('testOneBtn').addEventListener('click', testOneNFT)

// On load: if VeWorld is already there, hint at it.
window.addEventListener('load', () => {
  if (window.connex && window.connex.thor) {
    log('VeWorld detected. Click Connect Wallet to start.', 'ok')
  } else {
    log('VeWorld not detected. Install the extension and reload.', 'err')
  }
  refreshBalance().catch(() => {})
})
