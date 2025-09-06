import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasuryActual.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;
    const DEBUG = import.meta.env.VITE_DEBUG_MODE === 'true';

    const [treasury, setTreasury] = useState(null);
    const [nft, setNft] = useState(null);

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
        pendingBeforeMint: false
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
        pendingRevenue: '0'
    });

    const [analysis, setAnalysis] = useState(null);
    const [devSimInput, setDevSimInput] = useState('0.5');
    const [devSimResult, setDevSimResult] = useState('');

    const formatVTRU = (v) => {
        const n = parseFloat(v || '0');
        if (!isFinite(n) || n === 0) return '0.0000';
        if (n < 0.0001) return '<0.0001';
        return n.toFixed(4);
    };
    const big = (v) => ethers.getBigInt(v);

    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) init();
    }, [provider, treasuryAddress, nftAddress]);

    async function init() {
        try {
            setContractError('');
            const t = new ethers.Contract(treasuryAddress, (RevShareTreasuryAbi.abi || RevShareTreasuryAbi), provider);
            const n = new ethers.Contract(nftAddress, (RevShareNFTAbi.abi || RevShareNFTAbi), provider);

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
        analyze();
    }

    async function loadUser() {
        if (!wallet || !treasury || !nft) return;
        setLoading(true);
        try {
            let bal = 0;
            try { bal = Number((await nft.balanceOf(wallet)).toString()); } catch { }
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
                const id = await nft.tokenOfOwnerByIndex(addr, i);
                out.push(Number(id)); // ID may be 0
            }
            return out;
        } catch {
            const out = [];
            let supply = 0;
            try { supply = Number((await nft.totalSupply()).toString()); } catch { supply = 1200; }
            for (let tokenId = 0; tokenId < supply && out.length < balanceGuess; tokenId++) {
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
                if (caps.claimedPerTokenX18) {
                    try { claimedX18 = await treasury.claimedPerTokenX18(id); } catch { }
                }
                if (caps.claimable) {
                    try { claimableX18 = await treasury.claimable(id); } catch { }
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
                    deltaX18: (claimableX18).toString(),
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

    function analyze() {
        if (!perTokenInfo.length) {
            setAnalysis(null);
            return;
        }
        const t = treasuryStats;
        const anyPositive = positiveClaimIds.length > 0;
        const allZero = perTokenInfo.every(p => big(p.claimableX18) === 0n);
        let reason = '';
        if (anyPositive) {
            reason = 'claimable-positive';
        } else if (allZero) {
            // Distinguish between: need allocation, minted-after-allocation, or truly no income
            const pending = parseFloat(t.pendingRevenue);
            const cumulative = perTokenInfo[0]?.cumulative || '0';
            const cumulativeF = parseFloat(cumulative);
            const claimedEqualsCumulative = perTokenInfo.every(p => p.cumulativeX18 === p.claimedX18);
            if (pending > 0) {
                reason = 'needs-allocation';
            } else if (cumulativeF > 0 && claimedEqualsCumulative) {
                reason = 'minted-after-allocation';
            } else if (parseFloat(t.totalRevenue) > 0 && cumulativeF === 0) {
                reason = 'income-buffered-or-not-allocated';
            } else {
                reason = 'no-income';
            }
        }
        setAnalysis({
            reason,
            summary: classifyReasonLabel(reason),
            details: buildReasonDetail(reason)
        });
    }

    function classifyReasonLabel(r) {
        switch (r) {
            case 'claimable-positive': return 'You have claimable revenue.';
            case 'needs-allocation': return 'Pending revenue must be allocated.';
            case 'minted-after-allocation': return 'Token was minted after previous revenue allocation (baseline snapshot).';
            case 'income-buffered-or-not-allocated': return 'Treasury holds balance but cumulative not updated (needs forward/allocate).';
            case 'no-income': return 'No revenue has been distributed yet.';
            default: return 'Unknown state.';
        }
    }

    function buildReasonDetail(r) {
        switch (r) {
            case 'needs-allocation':
                return 'Call allocatePending() (button shows if available) to push pending into cumulative, then refresh.';
            case 'minted-after-allocation':
                return 'All your tokens’ claimedPerTokenX18 equal the current cumulative. You only earn on NEW incoming revenue. Send new native to the treasury (forwardNative) then allocate if needed.';
            case 'income-buffered-or-not-allocated':
                return 'Native balance present but not reflected in cumulative. It may be buffered (pendingBeforeMint) or just sitting before any allocation logic.';
            case 'no-income':
                return 'Contract has not received nor allocated any revenue after your token existed.';
            case 'claimable-positive':
                return 'Proceed to claim; tokens have deltas.';
            default:
                return 'Unable to classify. Provide raw snapshot for deeper analysis.';
        }
    }

    function decodeRevert(error) {
        if (!error) return 'Unknown';
        if (error.reason) return error.reason;
        if (error.error?.reason) return error.error.reason;
        try {
            if (error.data && treasury?.interface) {
                const errDecoded = treasury.interface.parseError(error.data);
                return `CustomError(${errDecoded?.name})`;
            }
        } catch { }
        return error.message || 'Reverted';
    }

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
            setStatus('Nothing claimable (see analyzer).');
            return;
        }
        setClaiming(true);
        try {
            const t = treasury.connect(signer);
            if (positiveClaimIds.length === 1 && caps.claim) {
                await execSingle(t, positiveClaimIds[0]);
                await afterClaim();
                return;
            }
            if (positiveClaimIds.length > 1 && caps.claimMany) {
                const ok = await staticTry(t, 'claimMany', [positiveClaimIds]);
                if (ok) {
                    await sendTx(t, 'claimMany', [positiveClaimIds]);
                    await afterClaim();
                    return;
                } else {
                    debugWarn('claimMany revert static; fallback loop');
                }
            }
            let success = 0;
            for (const id of positiveClaimIds) {
                const ok = await execSingle(t, id, true);
                if (ok) success++;
            }
            if (success === 0) {
                setStatus('All claims reverted (likely race or zero).');
            } else {
                setStatus(`Claimed ${success}/${positiveClaimIds.length}.`);
                await afterClaim();
            }
        } catch (e) {
            setStatus(`Claim failed: ${decodeRevert(e)}`);
        } finally {
            setClaiming(false);
        }
    }

    async function execSingle(t, tokenId, silent = false) {
        if (!caps.claim) return false;
        const ok = await staticTry(t, 'claim', [tokenId]);
        if (!ok) {
            if (!silent) setStatus(`Token ${tokenId} static revert.`);
            return false;
        }
        await sendTx(t, 'claim', [tokenId]);
        return true;
    }

    async function staticTry(t, fn, args) {
        try { await t.callStatic[fn](...args); return true; }
        catch (e) { debugWarn(`Static revert ${fn}`, decodeRevert(e)); return false; }
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

    async function afterClaim() {
        setStatus('Refreshing…');
        setDataLoaded(false);
        await computePerToken(userTokenIds);
        await loadTreasuryStats();
        analyze();
        setStatus('Done');
        setTimeout(() => setStatus(''), 3000);
    }

    async function handleAllocatePending() {
        if (!signer || !treasury || !caps.allocatePending) return;
        try {
            setStatus('Allocating pending…');
            const t = treasury.connect(signer);
            const ok = await staticTry(t, 'allocatePending', []);
            if (!ok) throw new Error('allocatePending static revert');
            await sendTx(t, 'allocatePending', []);
            await afterClaim();
        } catch (e) {
            setStatus(`Allocation failed: ${decodeRevert(e)}`);
        }
    }

    function simulateHypotheticalDelta() {
        try {
            if (!perTokenInfo.length) {
                setDevSimResult('No tokens.');
                return;
            }
            const add = ethers.parseEther(devSimInput || '0');
            const supply = BigInt(treasuryStats.totalShares || 1);
            const perShare = add / supply;
            const claimableEach = ethers.formatUnits(perShare, 18);
            setDevSimResult(`If ${devSimInput} VTRU added now, each token would get ≈ ${claimableEach} VTRU claimable.`);
        } catch (e) {
            setDevSimResult(`Error: ${e.message}`);
        }
    }

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

            {contractError && <Msg kind="error">{contractError}</Msg>}
            {status && !contractError && <Msg kind="info">{status}</Msg>}

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

            {/* Analyzer */}
            {analysis && (
                <div style={anBox}>
                    <strong>State Analyzer:</strong> {analysis.summary}
                    <div style={{ marginTop: 4, fontSize: '0.85rem', opacity: 0.85 }}>
                        {analysis.details}
                    </div>
                </div>
            )}

            {/* User Stats */}
            <div className="hp-section">
                <div className="hp-section__head"><h3>Your RevShare Stats</h3></div>
                <div className="hp-mini">
                    <Mini label="RevShare NFTs" value={userNFTBalance} />
                    <Mini label="Claimable" value={`${formatVTRU(claimableAmount)} VTRU`} />
                    <Mini label="Total Claimed (snap)" value={`${formatVTRU(totalClaimed)} VTRU`} />
                    <Mini label="Tokens With Delta" value={positiveClaimIds.length} />
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
                    <div style={{ textAlign: 'center', marginTop: '1.2rem', opacity: 0.65, fontStyle: 'italic' }}>
                        Nothing claimable (see analyzer above).
                    </div>
                )}
            </div>

            {/* Treasury */}
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

            {/* Diagnostics */}
            {DEBUG && (
                <div className="hp-section">
                    <div className="hp-section__head"><h3>Diagnostics</h3></div>
                    <div style={diagBox}>
                        <div>Token IDs: {userTokenIds.join(', ') || '—'}</div>
                        <div style={{ marginTop: 6, fontWeight: 600 }}>Per Token Snapshot:</div>
                        <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, border: '1px solid #222', padding: 6 }}>
                            {perTokenInfo.map(p => {
                                const zero = big(p.claimableX18) === 0n;
                                return (
                                    <div key={p.id} style={{ padding: '3px 0', display: 'flex', gap: 12, color: zero ? '#888' : '#fff' }}>
                                        <span>#{p.id}</span>
                                        <span>cumulative={p.cumulative}</span>
                                        <span>claimed={p.claimed}</span>
                                        <span>claimable={p.claimable}</span>
                                        {zero && <span style={{ color: '#ff6363' }}>Δ=0</span>}
                                    </div>
                                );
                            })}
                            {!perTokenInfo.length && <div>—</div>}
                        </div>
                        <div style={{ marginTop: 10, fontSize: 12 }}>
                            Dev Simulate New Income (not sending, just math):
                            <div style={{ marginTop: 4 }}>
                                <input
                                    style={{ width: 90, background: '#222', border: '1px solid #444', color: '#fff', padding: 4, fontFamily: 'monospace' }}
                                    value={devSimInput}
                                    onChange={(e) => setDevSimInput(e.target.value)}
                                />
                                <button
                                    className="hp-btn hp-btn--secondary"
                                    style={{ marginLeft: 8, padding: '0.35rem 0.7rem' }}
                                    onClick={simulateHypotheticalDelta}
                                >
                                    Simulate
                                </button>
                            </div>
                            {devSimResult && <div style={{ marginTop: 4, opacity: 0.85 }}>{devSimResult}</div>}
                        </div>
                        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.8 }}>
                            Notes:
                            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                                <li>“Minted after allocation” means you need NEW revenue for deltas.</li>
                                <li>Allocate pending if pendingRevenue &gt; 0.</li>
                                <li>If balance > 0 and cumulative == 0, contract logic didn’t allocate yet.</li>
                            </ul>
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
    const base = {
        padding: '1rem',
        marginBottom: '1.25rem',
        borderRadius: 8,
        fontSize: '0.95rem',
        lineHeight: 1.35
    };
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

const diagBox = {
    padding: '1rem',
    background: '#121212',
    border: '1px solid #2e2e2e',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 13
};
const anBox = {
    padding: '0.85rem 1rem',
    background: 'rgba(0,180,255,0.08)',
    border: '1px solid rgba(0,180,255,0.35)',
    borderRadius: 8,
    marginBottom: '1.25rem',
    fontSize: '0.9rem'
};
const overlay = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    background: 'rgba(0,0,0,0.88)',
    color: '#fff',
    padding: '1.5rem 2rem',
    borderRadius: 10,
    zIndex: 1000,
    fontSize: '1.05rem'
};

export default BlockSharePage;