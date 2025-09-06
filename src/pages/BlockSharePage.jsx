import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasuryActual.json'; // ensure this is the full ABI (has claim & claimMany)
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;
    const DEBUG = import.meta.env.VITE_DEBUG_MODE === 'true';

    // Contracts
    const [treasury, setTreasury] = useState(null);
    const [nft, setNft] = useState(null);

    // Status / UI
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [dataLoaded, setDataLoaded] = useState(false);

    // Capability flags
    const [caps, setCaps] = useState({
        claim: false,
        claimMany: false,
        claimable: false,
        cumulativePerTokenX18: false,
        claimedPerTokenX18: false,
        allocatePending: false,
        pendingBeforeMint: false
    });

    // User data
    const [userTokenIds, setUserTokenIds] = useState([]);
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [totalClaimed, setTotalClaimed] = useState('0');

    // Per token diagnostics
    const [perTokenInfo, setPerTokenInfo] = useState([]); // [{id, claimable, claimedX18, cumulativeX18, deltaX18}]
    const [positiveClaimIds, setPositiveClaimIds] = useState([]); // tokens with delta > 0

    // Treasury stats
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        pendingRevenue: '0'
    });

    const formatVTRU = (v) => {
        const n = parseFloat(v || '0');
        if (!isFinite(n) || n === 0) return '0.0000';
        if (n < 0.0001) return '<0.0001';
        return n.toFixed(4);
    };
    const big = (v) => ethers.getBigInt(v);

    /* =========================
       INIT
       ========================= */
    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) init();
    }, [provider, treasuryAddress, nftAddress]);

    async function init() {
        try {
            setContractError('');
            const t = new ethers.Contract(treasuryAddress, (RevShareTreasuryAbi.abi || RevShareTreasuryAbi), provider);
            const n = new ethers.Contract(nftAddress, (RevShareNFTAbi.abi || RevShareNFTAbi), provider);

            // Verify code present
            const [tCode, nCode] = await Promise.all([provider.getCode(treasuryAddress), provider.getCode(nftAddress)]);
            if (tCode === '0x') throw new Error('Treasury not deployed at address');
            if (nCode === '0x') throw new Error('NFT not deployed at address');

            setTreasury(t);
            setNft(n);
            await probeCapabilities(t, n);
            setDataLoaded(false);
        } catch (e) {
            const msg = `Init failed: ${e.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, e);
        }
    }

    async function probeCapabilities(t, n) {
        const c = { ...caps };
        try { t.interface.getFunction('claim'); c.claim = true; } catch { }
        try { t.interface.getFunction('claimMany'); c.claimMany = true; } catch { }
        try { await t.claimable(1).catch(() => { }); c.claimable = true; } catch { }
        try { await t.cumulativePerTokenX18(); c.cumulativePerTokenX18 = true; } catch { }
        try { await t.claimedPerTokenX18(1); c.claimedPerTokenX18 = true; } catch { }
        try { await t.pendingBeforeMint(); c.pendingBeforeMint = true; } catch { }
        try { t.interface.getFunction('allocatePending'); c.allocatePending = true; } catch { }
        try { await n.totalSupply(); } catch { }
        setCaps(c);
    }

    useEffect(() => {
        if (treasury && nft && wallet && !dataLoaded) {
            (async () => {
                await refreshAll();
                setDataLoaded(true);
            })();
        }
    }, [treasury, nft, wallet, dataLoaded]);

    async function refreshAll() {
        await loadUser();
        await loadTreasuryStats();
    }

    /* =========================
       USER DATA
       ========================= */
    async function loadUser() {
        if (!wallet || !treasury || !nft) return;
        setLoading(true);
        try {
            // Balance
            let bal = 0;
            try {
                bal = Number((await nft.balanceOf(wallet)).toString());
            } catch { }
            setUserNFTBalance(bal);

            // Token IDs
            const ids = await getUserTokenIds(wallet, bal);
            setUserTokenIds(ids);

            // Per-token inspection
            await computePerToken(ids);
        } catch (e) {
            criticalError('loadUser error', e);
            setStatus('Failed to load user data');
        } finally {
            setLoading(false);
        }
    }

    async function getUserTokenIds(addr, balanceGuess) {
        if (!addr) return [];
        if (balanceGuess === 0) return [];
        // Try enumerable first
        try {
            const out = [];
            for (let i = 0; i < balanceGuess; i++) {
                const id = await nft.tokenOfOwnerByIndex(addr, i);
                out.push(Number(id));
            }
            return out;
        } catch {
            // fallback scan
            const out = [];
            let supply = 0;
            try { supply = Number((await nft.totalSupply()).toString()); } catch { supply = 1200; }
            for (let tokenId = 1; tokenId <= supply && out.length < balanceGuess; tokenId++) {
                try {
                    const owner = await nft.ownerOf(tokenId);
                    if (owner.toLowerCase() === addr.toLowerCase()) out.push(tokenId);
                } catch { }
            }
            return out;
        }
    }

    async function computePerToken(ids) {
        if (!ids.length) {
            setPerTokenInfo([]);
            setClaimableAmount('0');
            setTotalClaimed('0');
            setPositiveClaimIds([]);
            return;
        }
        setCalculating(true);
        try {
            const per = [];
            let totalClaimableX18 = 0n;
            let totalClaimedX18 = 0n;
            let cumulative = 0n;
            if (caps.cumulativePerTokenX18) {
                try { cumulative = await treasury.cumulativePerTokenX18(); } catch { }
            }

            for (const id of ids) {
                let claimedX18 = 0n;
                let claimableX18 = 0n;
                // claimed snapshot
                if (caps.claimedPerTokenX18) {
                    try { claimedX18 = await treasury.claimedPerTokenX18(id); } catch { }
                }
                // direct claimable
                if (caps.claimable) {
                    try { claimableX18 = await treasury.claimable(id); } catch { }
                } else if (cumulative) {
                    // manual delta
                    const delta = cumulative - claimedX18;
                    if (delta > 0n) claimableX18 = delta;
                }
                totalClaimableX18 += claimableX18;
                totalClaimedX18 += claimedX18;
                per.push({
                    id,
                    claimableX18: claimableX18.toString(),
                    claimable: ethers.formatUnits(claimableX18, 18),
                    claimedX18: claimedX18.toString(),
                    claimed: ethers.formatUnits(claimedX18, 18),
                    cumulativeX18: cumulative.toString(),
                    deltaX18: claimableX18.toString()
                });
            }

            const positives = per.filter(p => big(p.claimableX18) > 0n).map(p => p.id);
            setPositiveClaimIds(positives);
            setPerTokenInfo(per);
            setClaimableAmount(ethers.formatUnits(totalClaimableX18, 18));
            setTotalClaimed(ethers.formatUnits(totalClaimedX18, 18));
        } finally {
            setCalculating(false);
        }
    }

    /* =========================
       TREASURY STATS
       ========================= */
    async function loadTreasuryStats() {
        if (!treasury) return;
        try {
            let totalRevenue = '0';
            try { totalRevenue = ethers.formatEther(await provider.getBalance(treasuryAddress)); } catch { }
            let totalShares = 0;
            try { totalShares = Number((await nft.totalSupply()).toString()); } catch { }
            let pendingRevenue = '0';
            if (caps.pendingBeforeMint) {
                try { pendingRevenue = ethers.formatUnits(await treasury.pendingBeforeMint(), 18); } catch { }
            }
            let revenuePerShare = '0';
            if (caps.cumulativePerTokenX18) {
                try {
                    const c = await treasury.cumulativePerTokenX18();
                    revenuePerShare = ethers.formatUnits(c, 18);
                } catch { }
            } else if (totalShares > 0) {
                revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
            }
            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                pendingRevenue
            });
        } catch (e) {
            debugWarn('loadTreasuryStats error', e);
        }
    }

    /* =========================
       REVERT DECODER
       ========================= */
    function decodeRevert(error) {
        if (!error) return 'Unknown';
        if (error.reason) return error.reason;
        if (error.error && error.error.reason) return error.error.reason;
        try {
            if (error.data && treasury?.interface) {
                const errDecoded = treasury.interface.parseError(error.data);
                return `CustomError(${errDecoded?.name})`;
            }
        } catch { }
        return error.message || 'Reverted';
    }

    /* =========================
       CLAIM
       ========================= */
    async function handleClaim() {
        if (!signer || !treasury) {
            setStatus('Wallet not ready');
            return;
        }
        if (calculating) {
            setStatus('Still computing claimable…');
            return;
        }
        if (!positiveClaimIds.length) {
            setStatus('Nothing claimable');
            return;
        }
        setClaiming(true);
        try {
            const t = treasury.connect(signer);
            // Decide strategy
            if (positiveClaimIds.length === 1 && caps.claim) {
                await claimSingle(t, positiveClaimIds[0]);
                await postClaimRefresh();
                return;
            }
            // Try batch first if available
            if (positiveClaimIds.length > 1 && caps.claimMany) {
                const ok = await staticTry(t, 'claimMany', [positiveClaimIds]);
                if (ok) {
                    await sendTx(t, 'claimMany', [positiveClaimIds]);
                    await postClaimRefresh();
                    return;
                } else {
                    debugWarn('claimMany static revert -> falling back to per-token loop');
                }
            }
            // Fallback loop
            let success = 0;
            for (const id of positiveClaimIds) {
                const ok = await claimSingle(t, id, true);
                if (ok) success++;
            }
            if (success === 0) {
                setStatus('All claim attempts reverted (likely zero deltas / allocation needed).');
            } else {
                setStatus(`Claimed ${success}/${positiveClaimIds.length} tokens.`);
                await postClaimRefresh();
            }
        } catch (e) {
            const msg = decodeRevert(e);
            criticalError('Claim failed', e);
            setStatus(`Claim failed: ${msg}`);
        } finally {
            setClaiming(false);
        }
    }

    async function postClaimRefresh() {
        setStatus('Refreshing after claim…');
        setDataLoaded(false);
        await computePerToken(userTokenIds);
        await loadTreasuryStats();
        setStatus('Claim complete');
        setTimeout(() => setStatus(''), 4000);
    }

    async function claimSingle(t, tokenId, silent = false) {
        if (!caps.claim) return false;
        // Confirm still > 0
        let cX18 = 0n;
        try { cX18 = big(await t.claimable(tokenId)); } catch {
            // if claimable() not reliable, attempt manual delta
            if (caps.cumulativePerTokenX18 && caps.claimedPerTokenX18) {
                try {
                    const cum = await t.cumulativePerTokenX18();
                    const last = await t.claimedPerTokenX18(tokenId);
                    const delta = cum - last;
                    if (delta > 0n) cX18 = delta;
                } catch { }
            }
        }
        if (cX18 <= 0n) {
            if (!silent) setStatus(`Token ${tokenId}: nothing claimable`);
            return false;
        }
        const ok = await staticTry(t, 'claim', [tokenId]);
        if (!ok) {
            if (!silent) setStatus(`Token ${tokenId} static revert`);
            return false;
        }
        await sendTx(t, 'claim', [tokenId]);
        return true;
    }

    async function staticTry(t, fn, args) {
        try {
            await t.callStatic[fn](...args);
            return true;
        } catch (e) {
            debugWarn(`Static revert ${fn}`, decodeRevert(e));
            return false;
        }
    }

    async function sendTx(t, fn, args) {
        let gasLimit;
        try {
            const est = await t.estimateGas[fn](...args);
            gasLimit = (est * 12n) / 10n;
        } catch {
            gasLimit = 400000n;
        }
        setStatus(`Sending ${fn}…`);
        const tx = await t[fn](...args, { gasLimit });
        setStatus('Waiting confirmation…');
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error('Execution failed');
        setStatus(`${fn} confirmed`);
    }

    /* =========================
       ALLOCATE (if needed)
       ========================= */
    async function handleAllocatePending() {
        if (!signer || !treasury || !caps.allocatePending) return;
        try {
            setStatus('Allocating pending revenue…');
            const t = treasury.connect(signer);
            const ok = await staticTry(t, 'allocatePending', []);
            if (!ok) throw new Error('allocatePending static revert');
            await sendTx(t, 'allocatePending', []);
            await postClaimRefresh();
        } catch (e) {
            setStatus(`Allocation failed: ${decodeRevert(e)}`);
        }
    }

    /* =========================
       RENDER
       ========================= */
    if (!provider) {
        return (
            <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                <h2>BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>Connect wallet to continue.</p>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>🏛️ BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>Claim your marketplace revenue share.</p>
            </div>

            {contractError && (
                <div style={errBoxStyle}>
                    <strong>Contract Error:</strong> {contractError}
                </div>
            )}

            {status && !contractError && (
                <div style={infoBoxStyle}>{status}</div>
            )}

            {wallet && (
                <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                    <button
                        className="hp-btn hp-btn--secondary"
                        disabled={loading}
                        onClick={async () => {
                            setStatus('Refreshing…');
                            await refreshAll();
                            setStatus('');
                        }}
                        style={{ marginRight: 12 }}
                    >
                        {loading ? 'Refreshing…' : '🔄 Refresh'}
                    </button>
                    {!!caps.allocatePending && parseFloat(treasuryStats.pendingRevenue) > 0 && (
                        <button
                            className="hp-btn hp-btn--primary"
                            onClick={handleAllocatePending}
                            disabled={claiming}
                        >
                            🏦 Allocate {formatVTRU(treasuryStats.pendingRevenue)} VTRU
                        </button>
                    )}
                </div>
            )}

            {/* User Stats */}
            <div className="hp-section">
                <div className="hp-section__head"><h3>Your RevShare Stats</h3></div>
                <div className="hp-mini">
                    <Mini label="RevShare NFTs" value={userNFTBalance} />
                    <Mini label="Claimable" value={`${formatVTRU(claimableAmount)} VTRU`} />
                    <Mini label="Total Claimed (snap)" value={`${formatVTRU(totalClaimed)} VTRU`} />
                    <Mini label="Claimable Tokens" value={positiveClaimIds.length} />
                </div>
                {wallet && !calculating && positiveClaimIds.length > 0 && (
                    <div style={{ textAlign: 'center', marginTop: '1.4rem' }}>
                        <button
                            className="hp-btn hp-btn--primary"
                            disabled={claiming}
                            onClick={handleClaim}
                            style={{ fontSize: '1.05rem', padding: '0.75rem 2.25rem' }}
                        >
                            {claiming ? 'Claiming…' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
                        </button>
                    </div>
                )}
                {wallet && !calculating && positiveClaimIds.length === 0 && (
                    <div style={{ textAlign: 'center', marginTop: '1.2rem', opacity: 0.6, fontStyle: 'italic' }}>
                        Nothing claimable
                    </div>
                )}
            </div>

            {/* Treasury */}
            <div className="hp-section">
                <div className="hp-section__head"><h3>Treasury</h3></div>
                <div className="hp-mini">
                    <Mini label="Treasury Balance" value={`${formatVTRU(treasuryStats.totalRevenue)} VTRU`} />
                    <Mini label="Total Shares" value={treasuryStats.totalShares} />
                    <Mini label="Revenue / Share" value={`${formatVTRU(treasuryStats.revenuePerShare)} VTRU`} />
                    {parseFloat(treasuryStats.pendingRevenue) > 0 && (
                        <Mini label="Pending Revenue" value={formatVTRU(treasuryStats.pendingRevenue)} highlight />
                    )}
                </div>
            </div>

            {/* Diagnostics */}
            {DEBUG && (
                <div className="hp-section">
                    <div className="hp-section__head"><h3>Diagnostics</h3></div>
                    <div style={diagBox}>
                        <div>Tokens: {userTokenIds.join(', ') || '—'}</div>
                        <div>Positive Claim IDs: {positiveClaimIds.join(', ') || '—'}</div>
                        <div style={{ marginTop: 8, fontWeight: 600 }}>Per Token:</div>
                        <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 12 }}>
                            {perTokenInfo.map(p => (
                                <div key={p.id} style={{ padding: '2px 0', borderBottom: '1px solid #222' }}>
                                    #{p.id} claimable={p.claimable} claimed={p.claimed} deltaX18={p.deltaX18}
                                </div>
                            ))}
                            {!perTokenInfo.length && <div>—</div>}
                        </div>
                        <div style={{ marginTop: 8, opacity: 0.8 }}>
                            Hints:
                            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                                <li>If all claimable=0, run allocation (if pending) or feed treasury with income.</li>
                                <li>Batch reverts if any token has zero delta.</li>
                                <li>“Static simulation failed” = contract revert (often zero claimable).</li>
                            </ul>
                        </div>
                    </div>
                </div>
            )}

            {loading && (
                <div style={overlay}>Loading…</div>
            )}
            {calculating && !loading && (
                <div style={overlay}>Calculating…</div>
            )}
        </div>
    );
};

/* =========================
   Small Components / Styles
   ========================= */
function Mini({ label, value, highlight }) {
    return (
        <div className="hp-mini__card" style={highlight ? { borderColor: '#ffeb3b' } : undefined}>
            <div className="hp-mini__label">{label}</div>
            <div className="hp-mini__value" style={highlight ? { color: '#ffeb3b' } : undefined}>{value}</div>
        </div>
    );
}

const errBoxStyle = {
    padding: '1rem',
    marginBottom: '1.25rem',
    borderRadius: 8,
    background: 'rgba(220,38,127,0.12)',
    border: '1px solid rgba(220,38,127,0.4)'
};
const infoBoxStyle = {
    padding: '1rem',
    marginBottom: '1.25rem',
    borderRadius: 8,
    background: 'rgba(85,51,255,0.15)',
    border: '1px solid rgba(85,51,255,0.4)'
};
const diagBox = {
    padding: '1rem',
    background: '#121212',
    border: '1px solid #2e2e2e',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 13
};
const overlay = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    background: 'rgba(0,0,0,0.85)',
    color: '#fff',
    padding: '1.5rem 2rem',
    borderRadius: 10,
    zIndex: 1000
};

export default BlockSharePage;