import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareNFTTreasuryAbi from '../abi/RevShareNFTTreasury.json';
import { debugWarn, criticalError } from '../utils/debugUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    // Use the new combined contract address, fall back to old treasury address if not set
    const contractAddress = import.meta.env.VITE_REVSHARE_NFT_TREASURY_ADDRESS || import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const DEBUG = import.meta.env.VITE_DEBUG_MODE === 'true';

    const [contract, setContract] = useState(null);

    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [dataLoaded, setDataLoaded] = useState(false);

    const [caps, setCaps] = useState({
        claim: false,
        claimMany: false,
        claimable: false,
        cumulativePerTokenX18: false,
        claimedPerTokenX18: false,
        allocatePending: false,
        pendingBeforeMint: false,
        forwardNative: false
    });

    const [userTokenIds, setUserTokenIds] = useState([]);
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [totalClaimed, setTotalClaimed] = useState('0');
    const [perTokenInfo, setPerTokenInfo] = useState([]);
    const [positiveClaimIds, setPositiveClaimIds] = useState([]);

    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        pendingRevenue: '0',
        cumulativeCallSuccess: false,
        realCumulative: '0',
        allocatedTotal: '0',
        unallocatedBalance: '0'
    });

    const [analysis, setAnalysis] = useState(null);

    const formatVTRU = (v) => {
        const n = parseFloat(v || '0');
        if (!isFinite(n) || n === 0) return '0.0000';
        if (n < 0.0001) return '<0.0001';
        return n.toFixed(4);
    };
    const big = (v) => ethers.getBigInt(v);

    useEffect(() => {
        if (provider && contractAddress) init();
    }, [provider, contractAddress]);

    async function init() {
        try {
            setContractError('');
            const c = new ethers.Contract(contractAddress, (RevShareNFTTreasuryAbi.abi || RevShareNFTTreasuryAbi), provider);
            const contractCode = await provider.getCode(contractAddress);
            if (contractCode === '0x') throw new Error('RevShare NFT Treasury not deployed at address');
            setContract(c);
            await probeCaps(c);
            setDataLoaded(false);
        } catch (e) {
            const msg = `Init failed: ${e.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, e);
        }
    }

    async function probeCaps(c) {
        const newCaps = { ...caps };
        try { c.interface.getFunction('claim'); newCaps.claim = true; } catch { }
        try { c.interface.getFunction('claimMany'); newCaps.claimMany = true; } catch { }
        try { await c.claimable(1).catch(() => { }); newCaps.claimable = true; } catch { }
        try { await c.cumulativePerTokenX18(); newCaps.cumulativePerTokenX18 = true; } catch { }
        try { await c.claimedPerTokenX18(1); newCaps.claimedPerTokenX18 = true; } catch { }
        try { await c.pendingBeforeMint(); newCaps.pendingBeforeMint = true; } catch { }
        try { c.interface.getFunction('allocatePending'); newCaps.allocatePending = true; } catch { }
        try { c.interface.getFunction('forwardNative'); newCaps.forwardNative = true; } catch { }
        try { await c.totalSupply(); } catch { }
        setCaps(newCaps);
    }

    useEffect(() => {
        if (contract && wallet && !dataLoaded) {
            (async () => {
                await refreshAll();
                setDataLoaded(true);
            })();
        }
    }, [contract, wallet, dataLoaded]);

    async function refreshAll() {
        await loadUser();
        await loadTreasuryStats();
        analyze();
    }

    async function loadUser() {
        if (!wallet || !contract) return;
        setLoading(true);
        try {
            let bal = 0;
            try { bal = Number((await contract.balanceOf(wallet)).toString()); } catch { }
            setUserNFTBalance(bal);
            const ids = await getUserTokenIds(wallet, bal);
            setUserTokenIds(ids);
            await computePerToken(ids);
        } catch (e) {
            criticalError('loadUser error', e);
            setStatus('Failed to load user data');
        } finally {
            setLoading(false);
        }
    }

    async function getUserTokenIds(addr, balanceGuess) {
        if (!addr || balanceGuess === 0) return [];
        try {
            const out = [];
            for (let i = 0; i < balanceGuess; i++) {
                const id = await contract.tokenOfOwnerByIndex(addr, i);
                out.push(Number(id)); // token IDs may start at 0 or 1
            }
            return out;
        } catch {
            const out = [];
            let supply = 0;
            try { supply = Number((await contract.totalSupply()).toString()); } catch { supply = 1200; }
            for (let tokenId = 0; tokenId < supply && out.length < balanceGuess; tokenId++) {
                try {
                    const owner = await contract.ownerOf(tokenId);
                    if (owner.toLowerCase() === addr.toLowerCase()) out.push(tokenId);
                } catch { }
            }
            return out;
        }
    }

    async function computePerToken(ids) {
        if (!ids.length) {
            setPerTokenInfo([]); setClaimableAmount('0'); setTotalClaimed('0'); setPositiveClaimIds([]); return;
        }
        setCalculating(true);
        try {
            const per = [];
            let totalClaimableX18 = 0n;
            let totalClaimedX18 = 0n;
            let cumulative = 0n;
            if (caps.cumulativePerTokenX18) {
                try { cumulative = await contract.cumulativePerTokenX18(); } catch { }
            }
            for (const id of ids) {
                let claimedX18 = 0n;
                let claimableX18 = 0n;
                if (caps.claimedPerTokenX18) {
                    try { claimedX18 = await contract.claimedPerTokenX18(id); } catch { }
                }
                if (caps.claimable) {
                    try { claimableX18 = await contract.claimable(id); } catch { }
                } else if (cumulative) {
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
                    cumulative: ethers.formatUnits(cumulative, 18),
                    deltaX18: claimableX18.toString(),
                    delta: ethers.formatUnits(claimableX18, 18)
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

    async function loadTreasuryStats() {
        if (!contract) return;
        try {
            let balanceWei = 0n;
            try { balanceWei = await provider.getBalance(contractAddress); } catch { }
            const totalRevenue = ethers.formatEther(balanceWei);

            let totalShares = 0;
            try { totalShares = Number((await contract.totalSupply()).toString()); } catch { }

            let pendingRevenue = '0';
            if (caps.pendingBeforeMint) {
                try { pendingRevenue = ethers.formatUnits(await contract.pendingBeforeMint(), 18); } catch { }
            }

            let cumulativeCallSuccess = false;
            let realCumulative = '0';
            try {
                if (caps.cumulativePerTokenX18) {
                    const c = await contract.cumulativePerTokenX18();
                    realCumulative = ethers.formatUnits(c, 18);
                    cumulativeCallSuccess = true;
                }
            } catch { }

            // If cumulative call failed or returned 0 fallback to naive revenue/share display
            let revenuePerShare = '0';
            if (cumulativeCallSuccess) {
                revenuePerShare = realCumulative;
            } else if (totalShares > 0) {
                revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
            }

            // Compute "allocatedTotal" = realCumulative * totalShares (if we have real cumulative)
            let allocatedTotal = '0';
            let unallocatedBalance = '0';
            if (cumulativeCallSuccess) {
                try {
                    const cX18 = ethers.parseUnits(realCumulative, 18);
                    const allocWei = cX18 * BigInt(totalShares);
                    allocatedTotal = ethers.formatUnits(allocWei, 18);
                    // compare to actual balance
                    const allocNum = parseFloat(allocatedTotal);
                    const balNum = parseFloat(totalRevenue);
                    if (balNum > allocNum) {
                        unallocatedBalance = (balNum - allocNum).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
                    }
                } catch { }
            } else {
                // entire balance effectively unallocated in distribution system
                unallocatedBalance = totalRevenue;
            }

            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                pendingRevenue,
                cumulativeCallSuccess,
                realCumulative,
                allocatedTotal,
                unallocatedBalance
            });
        } catch (e) {
            debugWarn('loadTreasuryStats error', e);
        }
    }

    function analyze() {
        if (!perTokenInfo.length) { setAnalysis(null); return; }
        const t = treasuryStats;
        const anyPositive = positiveClaimIds.length > 0;
        const allZero = perTokenInfo.every(p => big(p.claimableX18) === 0n);
        let reason = '';
        if (anyPositive) {
            reason = 'claimable-positive';
        } else if (allZero) {
            const pending = parseFloat(t.pendingRevenue);
            const cumulativeF = parseFloat(t.realCumulative || '0');
            const claimedEqualsCumulative = perTokenInfo.every(p => p.cumulativeX18 === p.claimedX18);
            if (!t.cumulativeCallSuccess) {
                reason = 'no-allocation-functioning';
            } else if (pending > 0) {
                reason = 'needs-allocation';
            } else if (cumulativeF > 0 && claimedEqualsCumulative) {
                reason = 'minted-after-allocation';
            } else if (parseFloat(t.unallocatedBalance) > 0 && cumulativeF === 0) {
                reason = 'unallocated-balance';
            } else {
                reason = 'no-income';
            }
        }
        setAnalysis({
            reason,
            summary: classify(reason),
            details: explain(reason)
        });
    }

    function classify(r) {
        switch (r) {
            case 'claimable-positive': return 'You have claimable revenue.';
            case 'needs-allocation': return 'Pending revenue must be allocated.';
            case 'minted-after-allocation': return 'Snapshot equals cumulative – wait for NEW income.';
            case 'unallocated-balance': return 'Balance not yet allocated (call forwardNative / allocate).';
            case 'no-allocation-functioning': return 'cumulativePerTokenX18 not updating (no allocation executed).';
            case 'no-income': return 'No distributed revenue after mint.';
            default: return 'Unknown state.';
        }
    }
    function explain(r) {
        const t = treasuryStats;
        switch (r) {
            case 'unallocated-balance':
                return `Treasury balance ${formatVTRU(t.totalRevenue)} > allocated ${formatVTRU(t.allocatedTotal)}. Call forwardNative() (with small value) then allocatePending() if pending appears.`;
            case 'no-allocation-functioning':
                return `cumulativePerTokenX18() call failed or zero while balance = ${formatVTRU(t.totalRevenue)}. Use Forward & Allocate buttons below.`;
            case 'needs-allocation':
                return 'pendingBeforeMint > 0. Use Allocate button.';
            case 'minted-after-allocation':
                return 'Your token baseline equals current cumulative. Wait for new income → forwardNative → allocatePending.';
            case 'no-income':
                return 'No income processed yet since you minted.';
            case 'claimable-positive':
                return 'Proceed to claim.';
            default:
                return 'Provide raw values for deeper help.';
        }
    }

    function decodeRevert(error) {
        if (!error) return 'Unknown';
        if (error.reason) return error.reason;
        if (error.error?.reason) return error.error.reason;
        return error.message || 'Reverted';
    }

    async function handleClaim() {
        if (!signer || !contract) { setStatus('Wallet not ready'); return; }
        if (calculating) { setStatus('Calculating…'); return; }
        if (!positiveClaimIds.length) { setStatus('Nothing claimable'); return; }
        setClaiming(true);
        try {
            const c = contract.connect(signer);
            if (positiveClaimIds.length === 1 && caps.claim) {
                await execSingle(c, positiveClaimIds[0]);
                await postClaim();
                return;
            }
            if (positiveClaimIds.length > 1 && caps.claimMany) {
                const ok = await staticTry(c, 'claimMany', [positiveClaimIds]);
                if (ok) {
                    await sendTx(c, 'claimMany', [positiveClaimIds]);
                    await postClaim();
                    return;
                }
            }
            let success = 0;
            for (const id of positiveClaimIds) {
                const ok = await execSingle(c, id, true);
                if (ok) success++;
            }
            if (success === 0) setStatus('All claim attempts reverted');
            else { setStatus(`Claimed ${success}/${positiveClaimIds.length}`); await postClaim(); }
        } catch (e) {
            setStatus(`Claim failed: ${decodeRevert(e)}`);
        } finally { setClaiming(false); }
    }

    async function execSingle(t, tokenId, silent = false) {
        if (!caps.claim) return false;
        const ok = await staticTry(t, 'claim', [tokenId]);
        if (!ok) { if (!silent) setStatus(`Token ${tokenId} revert`); return false; }
        await sendTx(t, 'claim', [tokenId]); return true;
    }
    async function staticTry(t, fn, args) {
        try { await t.callStatic[fn](...args); return true; }
        catch (e) { return false; }
    }
    async function sendTx(t, fn, args) {
        let gasLimit;
        try {
            const est = await t.estimateGas[fn](...args);
            gasLimit = (est * 12n) / 10n;
        } catch { gasLimit = 400000n; }
        setStatus(`Sending ${fn}…`);
        const tx = await t[fn](...args, { gasLimit });
        setStatus('Waiting confirmation…');
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error('Execution failed');
        setStatus(`${fn} confirmed`);
    }
    async function postClaim() {
        setStatus('Refreshing…');
        setDataLoaded(false);
        await computePerToken(userTokenIds);
        await loadTreasuryStats();
        analyze();
        setStatus('Done');
        setTimeout(() => setStatus(''), 3000);
    }

    async function handleForward() {
        if (!signer || !contract || !caps.forwardNative) return;
        try {
            setStatus('Calling forwardNative (0 value)…');
            const c = contract.connect(signer);
            // attempt zero value; if contract needs >0 supply ask user
            const tx = await c.forwardNative({ value: 0n });
            await tx.wait();
            setStatus('forwardNative confirmed. Refreshing…');
            await refreshAll();
            setStatus('Done');
        } catch (e) {
            setStatus(`forwardNative failed: ${decodeRevert(e)}`);
        }
    }

    async function handleForwardAndAllocate() {
        await handleForward();
        if (caps.allocatePending) await handleAllocatePending();
    }

    async function handleAllocatePending() {
        if (!signer || !contract || !caps.allocatePending) return;
        try {
            setStatus('Allocating pending…');
            const c = contract.connect(signer);
            const ok = await staticTry(c, 'allocatePending', []);
            if (!ok) { setStatus('allocatePending static revert'); return; }
            await sendTx(c, 'allocatePending', []);
            await postClaim();
        } catch (e) {
            setStatus(`Allocation failed: ${decodeRevert(e)}`);
        }
    }

    if (!provider) {
        return <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <h2>BlockShare Revenue Portal</h2>
            <p style={{ color: 'var(--hp-muted)' }}>Connect wallet to continue.</p>
        </div>;
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>🏛️ BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>Claim your marketplace revenue share.</p>
            </div>

            {contractError && <Msg kind="error">{contractError}</Msg>}
            {status && !contractError && <Msg kind="info">{status}</Msg>}

            {wallet && (
                <div style={{ textAlign: 'center', marginBottom: '1.2rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.75rem' }}>
                    <button className="hp-btn hp-btn--secondary" disabled={loading} onClick={async () => { setStatus('Refreshing…'); await refreshAll(); setStatus(''); }}>
                        {loading ? 'Refreshing…' : '🔄 Refresh'}
                    </button>
                    {caps.forwardNative && (
                        <button className="hp-btn hp-btn--secondary" onClick={handleForward} disabled={claiming}>
                            ➡️ Forward (allocate balance)
                        </button>
                    )}
                    {caps.forwardNative && caps.allocatePending && (
                        <button className="hp-btn hp-btn--primary" onClick={handleForwardAndAllocate} disabled={claiming}>
                            ⚡ Forward + Allocate
                        </button>
                    )}
                    {caps.allocatePending && parseFloat(treasuryStats.pendingRevenue) > 0 && (
                        <button className="hp-btn hp-btn--primary" onClick={handleAllocatePending} disabled={claiming}>
                            🏦 Allocate Pending {formatVTRU(treasuryStats.pendingRevenue)}
                        </button>
                    )}
                </div>
            )}

            {analysis && (
                <div style={anBox}>
                    <strong>State Analyzer:</strong> {analysis.summary}
                    <div style={{ marginTop: 4, fontSize: '0.85rem', opacity: 0.85 }}>{analysis.details}</div>
                    <div style={{ marginTop: 6, fontSize: '0.75rem', opacity: 0.6 }}>
                        Balance {formatVTRU(treasuryStats.totalRevenue)} | Real Cumulative {treasuryStats.cumulativeCallSuccess ? formatVTRU(treasuryStats.realCumulative) : '—'} |
                        Allocated {formatVTRU(treasuryStats.allocatedTotal)} | Unallocated {formatVTRU(treasuryStats.unallocatedBalance)}
                    </div>
                </div>
            )}

            <div className="hp-section">
                <div className="hp-section__head"><h3>Your RevShare Stats</h3></div>
                <div className="hp-mini">
                    <Mini label="RevShare NFTs" value={userNFTBalance} />
                    <Mini label="Claimable" value={`${formatVTRU(claimableAmount)} VTRU`} />
                    <Mini label="Total Claimed (snap)" value={`${formatVTRU(totalClaimed)} VTRU`} />
                    <Mini label="Tokens With Delta" value={positiveClaimIds.length} />
                </div>
                {wallet && !calculating && positiveClaimIds.length > 0 && (
                    <div style={{ textAlign: 'center', marginTop: '1.3rem' }}>
                        <button className="hp-btn hp-btn--primary" disabled={claiming} onClick={handleClaim} style={{ fontSize: '1.05rem', padding: '0.75rem 2.2rem' }}>
                            {claiming ? 'Claiming…' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
                        </button>
                    </div>
                )}
                {wallet && !calculating && positiveClaimIds.length === 0 && (
                    <div style={{ textAlign: 'center', marginTop: '1.1rem', opacity: 0.65, fontStyle: 'italic' }}>
                        Nothing claimable (allocate or forward revenue first)
                    </div>
                )}
            </div>

            <div className="hp-section">
                <div className="hp-section__head"><h3>Treasury</h3></div>
                <div className="hp-mini">
                    <Mini label="Balance" value={`${formatVTRU(treasuryStats.totalRevenue)} VTRU`} />
                    <Mini label="Total Shares" value={treasuryStats.totalShares} />
                    <Mini label="Revenue / Share" value={`${formatVTRU(treasuryStats.revenuePerShare)} VTRU`} />
                    {parseFloat(treasuryStats.pendingRevenue) > 0 && (
                        <Mini label="Pending Revenue" highlight value={`${formatVTRU(treasuryStats.pendingRevenue)} VTRU`} />
                    )}
                </div>
            </div>

            {DEBUG && (
                <div className="hp-section">
                    <div className="hp-section__head"><h3>Diagnostics</h3></div>
                    <div style={diagBox}>
                        <div>Token IDs: {userTokenIds.join(', ') || '—'}</div>
                        <div style={{ marginTop: 6, fontWeight: 600 }}>Per Token:</div>
                        <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, border: '1px solid #222', padding: 6 }}>
                            {perTokenInfo.map(p => {
                                const zero = big(p.claimableX18) === 0n;
                                return (
                                    <div key={p.id} style={{ padding: '3px 0', display: 'flex', flexWrap: 'wrap', gap: 12, color: zero ? '#888' : '#fff' }}>
                                        <span>#{p.id}</span>
                                        <span>cum={p.cumulative}</span>
                                        <span>claimed={p.claimed}</span>
                                        <span>claimable={p.claimable}</span>
                                        {zero && <span style={{ color: '#ff6363' }}>Δ=0</span>}
                                    </div>
                                );
                            })}
                            {!perTokenInfo.length && <div>—</div>}
                        </div>
                        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.8 }}>
                            If Unallocated &gt; 0: press Forward (allocates balance) then Allocate (if pending appears).
                        </div>
                    </div>
                </div>
            )}

            {(loading || calculating || claiming) && (
                <div style={overlay}>
                    {loading ? 'Loading…' : calculating ? 'Calculating…' : 'Claiming…'}
                </div>
            )}
        </div>
    );
};

function Msg({ kind, children }) {
    const base = { padding: '1rem', marginBottom: '1.25rem', borderRadius: 8, fontSize: '0.95rem', lineHeight: 1.35 };
    const style = kind === 'error'
        ? { ...base, background: 'rgba(220,38,127,0.12)', border: '1px solid rgba(220,38,127,0.45)' }
        : { ...base, background: 'rgba(85,51,255,0.15)', border: '1px solid rgba(85,51,255,0.4)' };
    return <div style={style}>{children}</div>;
}
function Mini({ label, value, highlight }) {
    return (
        <div className="hp-mini__card" style={highlight ? { borderColor: '#ffeb3b' } : undefined}>
            <div className="hp-mini__label">{label}</div>
            <div className="hp-mini__value" style={highlight ? { color: '#ffeb3b' } : undefined}>{value}</div>
        </div>
    );
}

const diagBox = { padding: '1rem', background: '#121212', border: '1px solid #2e2e2e', borderRadius: 8, fontFamily: 'monospace', fontSize: 13 };
const anBox = { padding: '0.85rem 1rem', background: 'rgba(0,180,255,0.08)', border: '1px solid rgba(0,180,255,0.35)', borderRadius: 8, marginBottom: '1.25rem', fontSize: '0.9rem' };
const overlay = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.88)', color: '#fff', padding: '1.5rem 2rem', borderRadius: 10, zIndex: 1000, fontSize: '1.05rem' };

export default BlockSharePage;