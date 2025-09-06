import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareTreasuryActualAbi from '../abi/RevShareTreasuryActual.json';
import RevShareTreasuryMinimalAbi from '../abi/RevShareTreasuryMinimal.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { convertToUSDCValue } from '../utils/tokenUtils'; // kept; used opportunistically

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    // ---- env ----
    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;
    const DEBUG = import.meta.env.VITE_DEBUG_MODE === 'true';
    const COUNT_HOLDERS = import.meta.env.VITE_RS_COUNT_HOLDERS === 'true';
    const MAX_HOLDER_SCAN = parseInt(import.meta.env.VITE_RS_MAX_HOLDER_SCAN || '400', 10);

    // ---- contracts ----
    const [treasury, setTreasury] = useState(null);
    const [treasuryActual, setTreasuryActual] = useState(null);
    const [treasuryMinimal, setTreasuryMinimal] = useState(null);
    const [nft, setNft] = useState(null);

    // ---- ui / status ----
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [loading, setLoading] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [dataLoaded, setDataLoaded] = useState(false);

    // ---- method availability (debug panel shows these) ----
    const [methodsWorking, setMethodsWorking] = useState({
        totalRevenue: false,              // via provider.getBalance(treasury)
        cumulativePerTokenX18: false,     // treasury.cumulativePerTokenX18()
        claimedPerTokenX18: false,        // treasury.claimedPerTokenX18(id)
        claimable: false,                 // treasury.claimable(uint256)
        claim: false,                     // treasury.claim(uint256)
        claimMany: false,                 // treasury.claimMany(uint256[])
        nft_totalSupply: false,           // nft.totalSupply()
        nft_balanceOf: false,             // nft.balanceOf()
        nft_tokenOfOwnerByIndex: false,   // nft.tokenOfOwnerByIndex()
        nft_ownerOf: false                // nft.ownerOf()
    });

    // ---- user data ----
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userShares, setUserShares] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState([]);
    const [claimableAmount, setClaimableAmount] = useState('0'); // string VTRU
    const [totalClaimed, setTotalClaimed] = useState('0');       // string VTRU

    // ---- treasury stats ----
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',     // balance (native)
        totalShares: 0,        // NFT supply
        revenuePerShare: '0',  // cumulative per token (X18) or fallback
        totalHolders: 0        // optional scan
    });

    // ---- helpers ----
    const formatVTRU = (amount) => {
        if (typeof amount === 'string' && amount.length > 15 && !amount.includes('.') && !amount.includes('e')) {
            try {
                const formatted = ethers.formatUnits(amount, 18);
                const num = parseFloat(formatted);
                if (num === 0) return '0.0000';
                if (num < 0.0001) return '< 0.0001';
                return num.toFixed(4);
            } catch {
                // fall through to numeric parse
            }
        }
        const num = parseFloat(amount || '0');
        if (!isFinite(num) || num === 0) return '0.0000';
        if (num < 0.0001) return '< 0.0001';
        return num.toFixed(4);
    };
    const big = (v) => {
        try { return ethers.getBigInt(v); } catch { return BigInt(v); }
    };

    // ---- init ----
    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) initContracts();
    }, [provider, treasuryAddress, nftAddress]);

    async function initContracts() {
        try {
            setContractError('');
            debugLog('Initializing RevShare contracts…');

            if (!treasuryAddress || !nftAddress) {
                const e = 'RevShare contract addresses not configured';
                setContractError(e);
                setStatus(e);
                return;
            }

            // Build 3 interfaces for debugging/compat
            const t = new ethers.Contract(treasuryAddress, (RevShareTreasuryAbi.abi || RevShareTreasuryAbi), provider);
            const tActual = new ethers.Contract(treasuryAddress, (RevShareTreasuryActualAbi.abi || RevShareTreasuryActualAbi), provider);
            const tMin = new ethers.Contract(treasuryAddress, (RevShareTreasuryMinimalAbi.abi || RevShareTreasuryMinimalAbi), provider);
            const n = new ethers.Contract(nftAddress, (RevShareNFTAbi.abi || RevShareNFTAbi), provider);

            // On-chain existence
            const [tCode, nCode] = await Promise.all([provider.getCode(treasuryAddress), provider.getCode(nftAddress)]);
            if (tCode === '0x') throw new Error('Treasury contract not found at address');
            if (nCode === '0x') throw new Error('NFT contract not found at address');

            setTreasury(t);
            setTreasuryActual(tActual);
            setTreasuryMinimal(tMin);
            setNft(n);
            setDataLoaded(false);

            // probe available fns (non-fatal)
            await testMethodAvailability(t, n);

            debugLog('Contracts ready.');
        } catch (err) {
            const msg = `Failed to initialize RevShare contracts: ${err.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, err);
        }
    }

    async function testMethodAvailability(t, n) {
        const m = { ...methodsWorking };
        // Treasury
        try { await t.cumulativePerTokenX18(); m.cumulativePerTokenX18 = true; } catch { }
        try { await t.claimedPerTokenX18(1); m.claimedPerTokenX18 = true; } catch { }
        try { await t.claimable(1); m.claimable = true; } catch { }
        try { t.interface.getFunction('claim'); m.claim = true; } catch { }
        try { t.interface.getFunction('claimMany'); m.claimMany = true; } catch { }
        // NFT
        try { await n.totalSupply(); m.nft_totalSupply = true; } catch { }
        try { await n.balanceOf(ethers.ZeroAddress); m.nft_balanceOf = true; } catch { }
        try { await n.tokenOfOwnerByIndex(ethers.ZeroAddress, 0); m.nft_tokenOfOwnerByIndex = true; } catch { }
        try { await n.ownerOf(1); m.nft_ownerOf = true; } catch { }
        setMethodsWorking(m);
    }

    // Load data once everything wired
    useEffect(() => {
        if (treasury && nft && wallet && !dataLoaded) {
            (async () => {
                await loadUserData();
                await loadTreasuryStats();
                setDataLoaded(true);
            })();
        }
    }, [treasury, nft, wallet, dataLoaded]);

    // ---- data loaders ----
    async function loadUserData() {
        if (!wallet || !treasury || !nft) return;

        try {
            setLoading(true);
            debugLog('Loading user RevShare data…');

            // Wallet balance (nfts => shares)
            let bal = 0;
            try {
                const b = await nft.balanceOf(wallet);
                bal = parseInt(b.toString(), 10);
                setUserNFTBalance(bal);
                setUserShares(bal);
            } catch (e) {
                debugWarn('balanceOf failed', e);
                setUserNFTBalance(0);
                setUserShares(0);
            }

            // Token IDs
            const ids = await getUserTokenIds(wallet);
            setUserTokenIds(ids);

            // Claimable (from cumulative X18 - last snapshot X18)
            const claimable = await calcClaimable(ids);
            setClaimableAmount(claimable);

            // Total claimed (sum of last snapshots)
            const tc = await calcTotalClaimed(ids);
            setTotalClaimed(tc);

            debugLog('User data loaded.');
        } catch (err) {
            criticalError('Error loading user data', err);
            setStatus('Failed to load your RevShare data');
        } finally {
            setLoading(false);
        }
    }

    async function loadTreasuryStats() {
        if (!treasury || !nft) return;

        try {
            debugLog('Loading treasury stats…');

            // Balance -> totalRevenue
            let totalRevenue = '0';
            try {
                const bal = await provider.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(bal);
                setMethodsWorking((m) => ({ ...m, totalRevenue: true }));
            } catch (e) {
                setMethodsWorking((m) => ({ ...m, totalRevenue: false }));
            }

            // Supply -> totalShares
            let totalShares = 0;
            try {
                const ts = await nft.totalSupply();
                totalShares = parseInt(ts.toString(), 10);
            } catch (e) {
                debugWarn('totalSupply failed', e);
            }

            // revenuePerShare -> cumulativePerTokenX18 (if present), else fallback
            let revenuePerShare = '0';
            try {
                const c = await treasury.cumulativePerTokenX18();
                const per = ethers.formatUnits(c, 18);
                if (parseFloat(per) > 0) {
                    revenuePerShare = Number(per).toFixed(8).replace(/\.?0+$/, '');
                    setMethodsWorking((m) => ({ ...m, cumulativePerTokenX18: true }));
                }
            } catch (e) {
                setMethodsWorking((m) => ({ ...m, cumulativePerTokenX18: false }));
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
                }
            }

            // Optional: unique holders (bounded scan)
            let totalHolders = 0;
            if (COUNT_HOLDERS) {
                try {
                    totalHolders = await computeUniqueHolders(totalShares);
                } catch (e) {
                    debugWarn('Holder scan failed', e);
                }
            }

            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                totalHolders
            });
        } catch (e) {
            debugWarn('loadTreasuryStats error', e);
        }
    }

    async function computeUniqueHolders(totalShares) {
        if (!nft) return 0;
        let cap = isFinite(MAX_HOLDER_SCAN) ? MAX_HOLDER_SCAN : 400;
        if (!totalShares || totalShares < cap) cap = totalShares || cap;

        const owners = new Set();
        try {
            // Prefer ERC721Enumerable if available
            if (methodsWorking.nft_tokenOfOwnerByIndex) {
                // We still need owners; enumerable doesn’t list globally. Fall back to ownerOf scanning.
            }
            // ownerOf scan 1..cap
            for (let id = 1; id <= cap; id++) {
                try {
                    const owner = await nft.ownerOf(id);
                    owners.add(owner.toLowerCase());
                } catch {
                    // burned or not minted yet
                }
            }
        } catch (e) {
            debugWarn('computeUniqueHolders error', e);
        }
        return owners.size;
    }

    async function getUserTokenIds(userAddr) {
        try {
            const balanceBN = await nft.balanceOf(userAddr);
            const balance = parseInt(balanceBN.toString(), 10);
            if (balance === 0) return [];

            // Try ERC721Enumerable
            try {
                const ids = [];
                for (let i = 0; i < balance; i++) {
                    const id = await nft.tokenOfOwnerByIndex(userAddr, i);
                    ids.push(parseInt(id.toString(), 10));
                }
                debugLog('IDs via tokenOfOwnerByIndex', ids);
                return ids;
            } catch {
                // Fallback: scan ownerOf
                const ids = [];
                let ts = 0;
                try {
                    const t = await nft.totalSupply();
                    ts = parseInt(t.toString(), 10);
                } catch {
                    ts = 1200; // safe cap
                }
                for (let tokenId = 1; tokenId <= ts && ids.length < balance; tokenId++) {
                    try {
                        const owner = await nft.ownerOf(tokenId);
                        if (owner.toLowerCase() === userAddr.toLowerCase()) ids.push(tokenId);
                    } catch {
                        // ignore non-existing
                    }
                }
                debugLog('IDs via ownerOf scan', ids);
                return ids;
            }
        } catch (e) {
            debugWarn('getUserTokenIds error', e);
            return [];
        }
    }

    async function calcClaimable(tokenIds) {
        if (!treasury || !tokenIds || tokenIds.length === 0) return '0';
        try {
            setCalculating(true);
            let totalX18 = big(0);

            // Try using the contract's built-in claimable function first
            try {
                for (const id of tokenIds) {
                    try {
                        const claimableAmount = await treasury.claimable(id);
                        totalX18 += big(claimableAmount);
                        debugLog(`Token ${id} claimable: ${ethers.formatUnits(claimableAmount, 18)} VTRU`);
                    } catch (e) {
                        debugWarn(`claimable(${id}) failed`, e);
                    }
                }
                if (totalX18 > 0) {
                    const out = ethers.formatUnits(totalX18, 18);
                    return Number(out).toFixed(8).replace(/\.?0+$/, '');
                }
            } catch (e) {
                debugWarn('Direct claimable method failed, falling back to manual calculation', e);
            }

            // Fallback: manual calculation using cumulative system
            try {
                const c = await treasury.cumulativePerTokenX18();
                totalX18 = big(0);

                for (const id of tokenIds) {
                    try {
                        const last = await treasury.claimedPerTokenX18(id);
                        const delta = c - last;
                        if (delta > 0) totalX18 += delta;
                    } catch {
                        // ignore
                    }
                }
                const out = ethers.formatUnits(totalX18, 18);
                return Number(out).toFixed(8).replace(/\.?0+$/, '');
            } catch (e) {
                debugWarn('Manual calculation also failed', e);
                return '0';
            }
        } catch (e) {
            debugWarn('calcClaimable error', e);
            return '0';
        } finally {
            setCalculating(false);
        }
    }

    async function calcTotalClaimed(tokenIds) {
        if (!treasury || !tokenIds || tokenIds.length === 0) return '0';
        try {
            let totalX18 = big(0);
            for (const id of tokenIds) {
                try {
                    const last = await treasury.claimedPerTokenX18(id);
                    totalX18 += last;
                } catch { }
            }
            const out = ethers.formatUnits(totalX18, 18);
            return Number(out).toFixed(8).replace(/\.?0+$/, '');
        } catch (e) {
            debugWarn('calcTotalClaimed error', e);
            return '0';
        }
    }

    // ---- claim ----
    async function handleClaim() {
        if (!signer || !treasury || calculating || parseFloat(claimableAmount) <= 0 || userTokenIds.length === 0) {
            setStatus('No claimable amount available or no tokens owned');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue…');

            const t = treasury.connect(signer);
            let tx;

            if (userTokenIds.length === 1) {
                tx = await claimWithRetry(t, 'claim', [userTokenIds[0]]);
            } else {
                try {
                    tx = await claimWithRetry(t, 'claimMany', [userTokenIds]);
                } catch (e) {
                    debugWarn('claimMany failed; trying per-token', e);
                    let okCount = 0;
                    for (const id of userTokenIds) {
                        try {
                            const single = await claimWithRetry(t, 'claim', [id]);
                            if (single) {
                                await single.wait();
                                okCount++;
                            }
                        } catch (e2) {
                            debugWarn(`claim(${id}) failed`, e2);
                        }
                    }
                    if (okCount > 0) {
                        setStatus(`Revenue claimed for ${okCount}/${userTokenIds.length} tokens.`);
                        setDataLoaded(false);
                        await loadUserData();
                        await loadTreasuryStats();
                        setTimeout(() => setStatus(''), 4000);
                        return;
                    } else {
                        throw new Error('Failed to claim for any tokens');
                    }
                }
            }

            if (tx) {
                setStatus('Tx submitted, awaiting confirmation…');
                const rc = await tx.wait();
                if (rc.status === 1) {
                    setStatus('Revenue claimed successfully!');
                    setDataLoaded(false);
                    await loadUserData();
                    await loadTreasuryStats();
                    setTimeout(() => setStatus(''), 4000);
                } else {
                    setStatus('Transaction failed');
                }
            }
        } catch (error) {
            criticalError('Error claiming revenue:', error);
            const msg = (error && (error.reason || error.message)) || 'Claim failed';
            if (msg.includes('native send fail')) {
                setStatus('Claim failed in treasury transfer (native send). Contract may lack balance or have a send bug.');
            } else if (msg.includes('insufficient funds')) {
                setStatus('Insufficient gas funds to claim.');
            } else if (msg.includes('user rejected')) {
                setStatus('Transaction cancelled.');
            } else {
                setStatus(`Claim failed: ${msg}`);
            }
        } finally {
            setClaiming(false);
        }
    }

    // ethers v6 gas strategies
    async function claimWithRetry(contractWithSigner, method, args) {
        const strategies = [
            { label: 'estimate', useEstimate: true },
            { label: 'high', gasLimit: 400000n },
            { label: 'very-high', gasLimit: 600000n },
            { label: 'emergency', gasLimit: 800000n },
        ];

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            try {
                let overrides = {};
                if (s.useEstimate) {
                    try {
                        const est = await contractWithSigner.estimateGas[method](...args);
                        const padded = (big(est) * 12n) / 10n; // +20%
                        overrides = { gasLimit: padded };
                        debugLog(`${method} gas est: ${est.toString()} -> using ${padded.toString()}`);
                    } catch (e) {
                        debugWarn('gas estimate failed, trying fixed gas next', e);
                        continue;
                    }
                } else {
                    overrides = { gasLimit: s.gasLimit };
                }
                const tx = await contractWithSigner[method](...args, overrides);
                return tx;
            } catch (e) {
                debugWarn(`${method} with "${s.label}" strategy failed`, e);
                const msg = (e && (e.reason || e.message)) || '';
                if (msg.includes('native send fail')) throw e;      // contract-level issue: no point retrying further
                if (i === strategies.length - 1) throw e;
            }
        }
    }

    // ---- render ----
    if (!provider) {
        return (
            <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>BlockShare Revenue Portal</h2>
                    <p style={{ color: 'var(--hp-muted)' }}>
                        Connect your wallet to view your revenue sharing stats and claim earnings.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>🏛️ BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>
                    Track your BlockDust marketplace revenue sharing and claim your earnings.
                </p>
            </div>

            {contractError && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px',
                    background: 'rgba(220, 38, 127, 0.1)', border: '1px solid rgba(220, 38, 127, 0.3)', color: '#ff6b6b'
                }}>
                    <strong>⚠️ Contract Issue:</strong> {contractError}
                </div>
            )}

            {status && !contractError && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px',
                    background: 'rgba(85, 51, 255, 0.1)', border: '1px solid rgba(85, 51, 255, 0.3)', color: '#fff'
                }}>
                    {status}
                </div>
            )}

            {DEBUG && treasury && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px',
                    background: 'rgba(30, 30, 30, 0.8)', border: '1px solid rgba(85, 51, 255, 0.3)',
                    fontSize: '0.85rem', fontFamily: 'monospace'
                }}>
                    <div style={{ color: '#00d4ff', marginBottom: '0.5rem' }}>🔍 Debug</div>
                    <div>Treasury: {treasuryAddress}</div>
                    <div>NFT: {nftAddress}</div>
                    <div>Data Loaded: {dataLoaded ? '✅' : '❌'}</div>
                    <div>Loading: {loading ? '🔄' : '✅'}</div>
                    <div>Calculating: {calculating ? '🔄' : '✅'}</div>
                    <div>Token IDs: [{userTokenIds.join(', ')}]</div>
                    <div>Claimable: {claimableAmount} VTRU</div>
                    <div style={{ marginTop: '0.5rem', color: '#ffeb3b' }}>Methods:</div>
                    <div>• totalRevenue(balance): {methodsWorking.totalRevenue ? '✅' : '❌'}</div>
                    <div>• cumulativePerTokenX18: {methodsWorking.cumulativePerTokenX18 ? '✅' : '❌'}</div>
                    <div>• claimedPerTokenX18: {methodsWorking.claimedPerTokenX18 ? '✅' : '❌'}</div>
                    <div>• claimable: {methodsWorking.claimable ? '✅' : '❌'}</div>
                    <div>• claim: {methodsWorking.claim ? '✅' : '❌'}</div>
                    <div>• claimMany: {methodsWorking.claimMany ? '✅' : '❌'}</div>
                    <div>• NFT totalSupply: {methodsWorking.nft_totalSupply ? '✅' : '❌'}</div>
                    <div>• NFT balanceOf: {methodsWorking.nft_balanceOf ? '✅' : '❌'}</div>
                    <div>• NFT tokenOfOwnerByIndex: {methodsWorking.nft_tokenOfOwnerByIndex ? '✅' : '❌'}</div>
                    <div>• NFT ownerOf: {methodsWorking.nft_ownerOf ? '✅' : '❌'}</div>

                    {COUNT_HOLDERS && (
                        <div style={{ marginTop: '0.5rem' }}>
                            <button
                                className="hp-btn hp-btn--secondary"
                                onClick={async () => {
                                    setStatus('Scanning holders…');
                                    const n = await computeUniqueHolders(treasuryStats.totalShares);
                                    setTreasuryStats((s) => ({ ...s, totalHolders: n }));
                                    setStatus('');
                                }}
                                style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
                            >
                                Re-scan holders (cap {MAX_HOLDER_SCAN})
                            </button>
                        </div>
                    )}
                </div>
            )}

            {wallet && treasury && (
                <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
                    <button
                        className="hp-btn hp-btn--secondary"
                        onClick={async () => {
                            setDataLoaded(false);
                            setStatus('Refreshing data…');
                            await loadUserData();
                            await loadTreasuryStats();
                            setStatus('');
                        }}
                        disabled={loading}
                        style={{ fontSize: '0.9rem', padding: '0.5rem 1rem', opacity: loading ? 0.6 : 1 }}
                    >
                        {loading ? 'Refreshing…' : '🔄 Refresh Data'}
                    </button>
                </div>
            )}

            {/* User Stats */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>Your RevShare Stats</h3>
                </div>

                <div className="hp-mini">
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">RevShare NFTs Owned</div>
                        <div className="hp-mini__value">{userNFTBalance.toLocaleString()}</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Your Shares</div>
                        <div className="hp-mini__value">{userShares.toLocaleString()}</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Claimable Amount</div>
                        <div className="hp-mini__value">
                            {calculating ? 'Calculating…' : `${formatVTRU(claimableAmount)} VTRU`}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Claimed (lifetime)</div>
                        <div className="hp-mini__value">{formatVTRU(totalClaimed)} VTRU</div>
                    </div>
                </div>

                {wallet && !calculating && parseFloat(claimableAmount) > 0 && userTokenIds.length > 0 && (
                    <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                        <button
                            className="hp-btn hp-btn--primary"
                            onClick={handleClaim}
                            disabled={claiming || loading}
                            style={{ fontSize: '1.1rem', padding: '0.75rem 2rem' }}
                        >
                            {claiming ? 'Claiming…' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
                        </button>
                    </div>
                )}

                {wallet && !calculating && parseFloat(claimableAmount) === 0 && (
                    <div style={{ marginTop: '1.5rem', textAlign: 'center', color: 'var(--hp-muted)', fontStyle: 'italic' }}>
                        No revenue available to claim at this time
                    </div>
                )}
            </div>

            {/* Treasury Stats */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>Treasury Statistics</h3>
                </div>

                <div className="hp-mini">
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Revenue (balance)</div>
                        <div className="hp-mini__value">
                            {formatVTRU(treasuryStats.totalRevenue)} VTRU
                            {/* Optional USD value if you wired convertToUSDCValue */}
                            {/* <div className="hp-mini__sub">{usdValue}</div> */}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Shares</div>
                        <div className="hp-mini__value">{treasuryStats.totalShares.toLocaleString()}</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Revenue per Share</div>
                        <div className="hp-mini__value">{formatVTRU(treasuryStats.revenuePerShare)} VTRU</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Holders</div>
                        <div className="hp-mini__value">{treasuryStats.totalHolders.toLocaleString()}</div>
                    </div>
                </div>
            </div>

            {/* How it works */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>How BlockShare Works</h3>
                </div>
                <div style={{ color: 'var(--hp-muted)', lineHeight: 1.6 }}>
                    <p><strong>Revenue Sharing:</strong> A portion of marketplace fees is automatically distributed to RevShare NFT holders.</p>
                    <p><strong>Your Share:</strong> Each RevShare NFT grants you shares in the revenue pool proportional to your holdings.</p>
                    <p><strong>Claiming:</strong> Revenue accumulates over time and can be claimed anytime when available.</p>
                    <p><strong>Mint RevShare NFTs:</strong> Visit the <a href="/mint" style={{ color: 'var(--hp-accent)' }}>Mint page</a> to acquire more RevShare NFTs and increase your revenue share.</p>
                </div>
            </div>

            {loading && (
                <div style={{
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    background: 'rgba(0,0,0,0.8)', padding: '2rem', borderRadius: '8px', color: '#fff', zIndex: 1000
                }}>
                    Loading RevShare data…
                </div>
            )}
        </div>
    );
};

export default BlockSharePage;
