// Unstake NFTs admin tool — vanilla JS, Connex/VeWorld based.
//
// Calls staking.exit(tokenId) DIRECTLY on the staking pool, batched
// as multi-clause transactions. Each exit() sends the NFT back to its
// original ticketOwner (recorded in tokenDetail). The connected wallet
// must hold DEFAULT_ADMIN (or OPERATOR_ROLE) on the staking pool.
//
// Why not go through a recovery contract: the recovery intermediary
// adds a second permission layer (caller needs OPERATOR_ROLE on the
// recovery contract too), and complicates the failure surface. The
// admin already has all the access they need; we just sign clauses.

const NODE_URL = 'https://mainnet.vechain.org'

// ──────────────────────────────────────────────────────────────────────
// ABIs (minimal, just what we call)
// ──────────────────────────────────────────────────────────────────────

const ABI_EXIT = {
  inputs: [{ internalType: 'uint256', name: '_tokenId', type: 'uint256' }],
  name: 'exit',
  outputs: [],
  stateMutability: 'nonpayable',
  type: 'function',
}

const ABI_BALANCE_OF = {
  inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  stateMutability: 'view',
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
  batch:       $('batchInput'),
  walletState: $('walletState'),
  connectBtn:  $('connectBtn'),
  testOneBtn:  $('testOneBtn'),
  testStatus:  $('testStatus'),
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

function setTestStatus(text, cls = '') {
  els.testStatus.textContent = text
  els.testStatus.className = 'status ' + cls
}

function lockInputsForRun(locked) {
  ['staking', 'nft', 'batch'].forEach((k) => {
    els[k].disabled = locked
  })
  els.testOneBtn.disabled = locked || !state.signer
  els.unstakeBtn.disabled = locked || !state.signer
  els.connectBtn.disabled = locked
  els.stopBtn.disabled = !locked
}

// ──────────────────────────────────────────────────────────────────────
// Connex / VeWorld detection
// ──────────────────────────────────────────────────────────────────────
//
// VeWorld extension (current builds) injects window.vechain with a
// newConnex({ node, network }) factory. Older Sync2 / older VeWorld
// builds injected window.connex directly. Detect both, poll briefly
// to give the extension time to inject.

let _connex = null

async function ensureConnex(timeoutMs = 4000) {
  if (_connex) return _connex

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (window.vechain && typeof window.vechain.newConnex === 'function') {
      try {
        _connex = await window.vechain.newConnex({
          node: NODE_URL,
          network: 'main',
        })
        return _connex
      } catch (e) {
        // sometimes throws on first invocation; loop and retry
      }
    }
    if (window.vechain && window.vechain.thor && window.vechain.vendor) {
      _connex = window.vechain
      return _connex
    }
    if (window.connex && window.connex.thor && window.connex.vendor) {
      _connex = window.connex
      return _connex
    }
    await new Promise((res) => setTimeout(res, 100))
  }

  const seen = `window.vechain=${typeof window.vechain}, window.connex=${typeof window.connex}`
  throw new Error(
    `VeWorld not detected after ${timeoutMs}ms. ${seen}. ` +
    'Install VeWorld and make sure it is enabled for this site.'
  )
}

// ──────────────────────────────────────────────────────────────────────
// Chain reads
// ──────────────────────────────────────────────────────────────────────

async function readBalanceOf(tokenAddr, holder) {
  const connex = await ensureConnex()
  const m = connex.thor.account(tokenAddr).method(ABI_BALANCE_OF)
  const r = await m.call(holder)
  return BigInt(r.decoded[0])
}

async function readTokenIdAt(nftAddr, owner, index) {
  const connex = await ensureConnex()
  const m = connex.thor.account(nftAddr).method(ABI_TOKEN_OF_OWNER_BY_INDEX)
  const r = await m.call(owner, index)
  return r.decoded[0]
}

// Batch-fetch tokenIds at indices [0..n-1] in parallel.
async function readNextNTokenIds(nftAddr, staking, n) {
  const connex = await ensureConnex()
  const m = connex.thor.account(nftAddr).method(ABI_TOKEN_OF_OWNER_BY_INDEX)
  const tasks = []
  for (let i = 0; i < n; i++) {
    tasks.push(
      m.call(staking, i).then((r) => r.decoded[0]).catch(() => null)
    )
  }
  const results = await Promise.all(tasks)
  return results.filter((x) => x !== null && x !== undefined)
}

async function waitForReceipt(txid, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const connex = await ensureConnex()
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
    const connex = await ensureConnex()
    const cert = {
      purpose: 'identification',
      payload: { type: 'text', content: 'Sign in to Unstake NFTs admin tool' },
    }
    const r = await connex.vendor.sign('cert', cert).request()
    state.signer = r.annex.signer
    els.walletState.innerHTML = `Connected as <code class="lime">${state.signer}</code>`
    els.walletState.classList.remove('muted')
    els.testOneBtn.disabled = false
    els.unstakeBtn.disabled = false
    log(`Wallet connected: ${state.signer}`, 'ok')
  } catch (err) {
    log(`Connect failed: ${err.message}`, 'err')
  }
}

// ──────────────────────────────────────────────────────────────────────
// Step 1 — Test 1 NFT
// ──────────────────────────────────────────────────────────────────────

async function testOneNFT() {
  if (!state.signer) return
  const staking = els.staking.value.trim()
  const nft     = els.nft.value.trim()
  if (!staking || !nft) {
    setTestStatus('Fill staking + nft addresses first.', 'error')
    return
  }
  setTestStatus('Reading first staked tokenId...')
  log('Test: reading tokenOfOwnerByIndex(staking, 0)...', 'info')
  try {
    const tokenId = await readTokenIdAt(nft, staking, 0)
    log(`First staked tokenId: ${tokenId}`, 'info')

    const connex = await ensureConnex()
    const exitMethod = connex.thor.account(staking).method(ABI_EXIT)
    const clause = exitMethod.asClause(tokenId)

    setTestStatus(`Signing exit(${tokenId})...`)
    const r = await connex.vendor.sign('tx', [clause])
      .signer(state.signer)
      .gas(400000)
      .comment(`Test exit(${tokenId}) on ${staking.slice(0, 10)}…`)
      .request()
    log(`Tx submitted: ${r.txid}`, 'lime')

    setTestStatus(`Waiting for receipt (${r.txid.slice(0, 10)}…)...`)
    const receipt = await waitForReceipt(r.txid)
    if (receipt.reverted) {
      setTestStatus('Reverted. exit() does not pass on this pool from this wallet.', 'error')
      log(`Test reverted at block ${receipt.meta.blockNumber}`, 'err')
      log(`Likely cause: signer wallet does not have DEFAULT_ADMIN/OPERATOR on the staking pool.`, 'err')
    } else {
      setTestStatus(`Passed ✓ Token ${tokenId} returned to original staker. Safe to run the full loop.`, 'ok')
      log(`Test confirmed in block ${receipt.meta.blockNumber}. NFT back to ticketOwner.`, 'ok')
    }
    await refreshBalance()
  } catch (err) {
    setTestStatus(`Failed: ${err.message}`, 'error')
    log(`Test failed: ${err.message}`, 'err')
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

async function startUnstake() {
  if (state.running) return
  if (!state.signer) return

  const staking   = els.staking.value.trim()
  const nft       = els.nft.value.trim()
  const batchSize = parseInt(els.batch.value, 10)

  if (!staking || !nft || !batchSize) {
    log('Fill all addresses + batch size first.', 'err')
    return
  }
  if (batchSize < 1 || batchSize > 100) {
    log('Batch size must be between 1 and 100 (block gas constraint).', 'err')
    return
  }

  state.running = true
  state.stopRequested = false
  lockInputsForRun(true)
  log('==== Unstake loop started ====', 'lime')
  log(`Staking pool: ${staking}`, 'info')
  log(`NFT:          ${nft}`, 'info')
  log(`Batch size:   ${batchSize} exit() clauses per tx`, 'info')

  const initial = await refreshBalance()
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
  const connex = await ensureConnex()
  const exitMethod = connex.thor.account(staking).method(ABI_EXIT)

  while (!state.stopRequested) {
    const remaining = await readBalanceOf(nft, staking).then(Number)
    if (remaining === 0) {
      log('Staking pool drained. ✓', 'ok')
      break
    }

    const size = Math.min(batchSize, remaining)
    const label = `Tx #${batch} · packing ${size} exits · remaining ${remaining}`
    log(label, 'info')

    try {
      // 1. Enumerate `size` tokenIds at indices 0..size-1 (parallel reads)
      log(`  Reading ${size} tokenIds via tokenOfOwnerByIndex...`, 'info')
      const tokenIds = await readNextNTokenIds(nft, staking, size)
      if (tokenIds.length !== size) {
        log(`  Got ${tokenIds.length} tokenIds (expected ${size}). Trimming batch.`, 'err')
      }
      const actualSize = tokenIds.length
      if (actualSize === 0) {
        log('  No tokenIds returned. Aborting.', 'err')
        break
      }

      // 2. Build N exit() clauses
      const clauses = tokenIds.map((tid) => exitMethod.asClause(tid))
      log(`  TokenIds in this batch: ${tokenIds.join(', ')}`, 'info')

      // 3. Sign multi-clause tx
      // ~200k gas per exit on this contract; add 100k headroom for tx overhead.
      const gas = 100000 + 220000 * actualSize
      const r = await connex.vendor.sign('tx', clauses)
        .signer(state.signer)
        .gas(gas)
        .comment(`exit() x ${actualSize} on ${staking.slice(0, 10)}…`)
        .request()
      log(`  tx: ${r.txid}`, 'lime')

      // 4. Wait for receipt
      const receipt = await waitForReceipt(r.txid, { timeoutMs: 180000 })
      if (receipt.reverted) {
        log(`  ${label} reverted. Waiting 5s before retrying...`, 'err')
        await new Promise((res) => setTimeout(res, 5000))
      } else {
        const newRemaining = await readBalanceOf(nft, staking).then(Number)
        setProgress(total - newRemaining, total)
        log(`  confirmed in block ${receipt.meta.blockNumber}. Remaining ${newRemaining}.`, 'ok')
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
    // tiny pacing between txs to keep the UI smooth.
    await new Promise((res) => setTimeout(res, 1000))
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
els.testOneBtn.addEventListener('click', testOneNFT)
els.unstakeBtn.addEventListener('click', startUnstake)
els.stopBtn.addEventListener('click', stopUnstake)
els.refreshBtn.addEventListener('click', refreshBalance)

window.addEventListener('load', async () => {
  try {
    await ensureConnex()
    log('VeWorld detected. Click Connect Wallet to start.', 'ok')
  } catch (err) {
    log(err.message, 'err')
  }
  refreshBalance().catch(() => {})
})
