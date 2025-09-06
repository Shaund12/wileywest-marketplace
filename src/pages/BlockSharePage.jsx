import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasuryActual.json'; // must include: cumulativePerTokenX18, claimedPerTokenX18, claim, claimMany
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

    // UI / status
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [loading, setLoading] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [dataLoaded, setDataLoaded] = useState(false);

    // Method availability flags (for debug panel)
    const [methodsWorking, setMethodsWorking] = useState({
        totalRevenue: false,
        actualContract: false
    });

    // User data
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userShares, setUserShares] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState([]);
    const [claimableAmount, setClaimableAmount] = useState('0');  // string VTRU
    const [totalClaimed, setTotalClaimed] = useState('0');        // string VTRU (sum of last snapshots)

    // Treasury stats
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',   // current contract balance
        totalShares: 0,      // NFT total supply
        revenuePerShare: '0',
        totalHolders: 0      // (left as 0 unless you compute externally)
    });

    // ---------- helpers ----------
    const formatVTRU = (amount) => {
        // Accept numbers, strings, or wei-like strings
        if (typeof amount === 'string' && amount.length > 15 && !amount.includes('.') && !amount.includes('e')) {
            try {
                const formatted = ethers.formatUnits(amount, 18);
                const num = parseFloat(formatted);
                if (num === 0) return '0.0000';
                if (num < 0.0001) return '< 0.0001';
                return num.toFixed(4);
            } catch {
                // fall back below
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

    // ---------- init ----------
    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) {
            initContracts();
        }
    }, [provider, treasuryAddress, nftAddress]);

    async function initContracts() {
        try {
            setContractError('');
            debugLog('Initializing RevShare contracts...');

            if (!treasuryAddress || !nftAddress) {
                const e = 'RevShare contract addresses not configured';
                setContractError(e);
                setStatus(e);
                return;
            }

            const t = new ethers.Contract(treasuryAddress, RevShareTreasuryAbi.abi || RevShareTreasuryAbi, provider);
            const n = new ethers.Contract(nftAddress, RevShareNFTAbi.abi || RevShareNFTAbi, provider);

            // On-chain code check
            const [tCode, nCode] = await Promise.all([provider.getCode(treasuryAddress), provider.getCode(nftAddress)]);
            if (tCode === '0x') throw new Error('Treasury contract not found at address');
            if (nCode === '0x') throw new Error('NFT contract not found at address');

            setTreasury(t);
            setNft(n);
            setDataLoaded(false);
            debugLog('Contracts OK');

        } catch (err) {
            const msg = `Failed to initialize RevShare contracts: ${err.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, err);
            return;
        }
    }

    // Load once everything is ready
    useEffect(() => {
        if (treasury && nft && wallet && !dataLoaded) {
            (async () => {
                await loadUserData();
                await loadTreasuryStats();
                setDataLoaded(true);
            })();
        }
    }, [treasury, nft, wallet, dataLoaded]);

    // ---------- data loaders ----------
    async function loadUserData() {
        if (!wallet || !treasury || !nft) return;

        try {
            setLoading(true);
            debugLog('Loading user data...');

            // user NFT balance / shares
            let bal = 0;
            try {
                const b = await nft.balanceOf(wallet);
                bal = parseInt(b.toString());
            } catch (e) {
                debugWarn('balanceOf failed', e);
            }
            setUserNFTBalance(bal);
            setUserShares(bal);

            // token ids
            const ids = await getUserTokenIds(wallet);
            setUserTokenIds(ids);

            // claimable
            const claimable = await calcClaimable(ids);
            setClaimableAmount(claimable);

            // total claimed (sum of last snapshots per token)
            const tc = await calcTotalClaimed(ids);
            setTotalClaimed(tc);

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
            debugLog('Loading treasury stats...');
            let totalRevenue = '0';
            let totalShares = 0;
            let revenuePerShare = '0';

            // Current contract balance (native)
            try {
                const bal = await provider.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(bal);
                setMethodsWorking((m) => ({ ...m, totalRevenue: true }));
            } catch (e) {
                setMethodsWorking((m) => ({ ...m, totalRevenue: false }));
            }

            // NFT total supply = shares
            try {
                const ts = await nft.totalSupply();
                totalShares = parseInt(ts.toString());
            } catch (e) {
                debugWarn('totalSupply failed', e);
            }

            // revenuePerShare from contract’s cumulativePerTokenX18 if present
            try {
                const c = await treasury.cumulativePerTokenX18();
                const per = ethers.formatUnits(c, 18);
                if (parseFloat(per) > 0) {
                    revenuePerShare = Number(per).toFixed(8).replace(/\.?0+$/, '');
                    setMethodsWorking((m) => ({ ...m, actualContract: true }));
                }
            } catch (e) {
                setMethodsWorking((m) => ({ ...m, actualContract: false }));
                // fallback calc
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
                }
            }

            setTreasuryStats((s) => ({
                ...s,
                totalRevenue,
                totalShares,
                revenuePerShare
            }));
        } catch (e) {
            debugWarn('loadTreasuryStats error', e);
        }
    }

    async function getUserTokenIds(userAddr) {
        try {
            const balanceBN = await nft.balanceOf(userAddr);
            const balance = parseInt(balanceBN.toString());
            if (balance === 0) return [];

            // Try ERC721Enumerable
            try {
                const ids = [];
                for (let i = 0; i < balance; i++) {
                    const id = await nft.tokenOfOwnerByIndex(userAddr, i);
                    ids.push(parseInt(id.toString()));
                }
                debugLog('IDs via tokenOfOwnerByIndex', ids);
                return ids;
            } catch {
                // Fallback: scan 1..totalSupply and match owner
                const ids = [];
                let ts = 0;
                try {
                    const t = await nft.totalSupply();
                    ts = parseInt(t.toString());
                } catch {
                    // if no totalSupply, assume <= 1200
                    ts = 1200;
                }
                for (let tokenId = 1; tokenId <= ts && ids.length < balance; tokenId++) {
                    try {
                        const owner = await nft.ownerOf(tokenId);
                        if (owner.toLowerCase() === userAddr.toLowerCase()) ids.push(tokenId);
                    } catch {
                        // skip non-existent
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
            const c = await treasury.cumulativePerTokenX18();
            let totalX18 = big(0);

            for (const id of tokenIds) {
                try {
                    const last = await treasury.claimedPerTokenX18(id);
                    const delta = c - last;
                    if (delta > 0) totalX18 += delta;
                } catch (e) {
                    // ignore bad token
                }
            }

            const out = ethers.formatUnits(totalX18, 18);
            return Number(out).toFixed(8).replace(/\.?0+$/, '');
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
                    const last = await treasury.claimedPerTokenX18(id); // snapshot at last claim in X18
                    totalX18 += last;
                } catch {
                    // ignore
                }
            }
            const out = ethers.formatUnits(totalX18, 18);
            return Number(out).toFixed(8).replace(/\.?0+$/, '');
        } catch (e) {
            debugWarn('calcTotalClaimed error', e);
            return '0';
        }
    }

    // ---------- claim ----------
    async function handleClaim() {
        if (!signer || !treasury || calculating || parseFloat(claimableAmount) <= 0 || userTokenIds.length === 0) {
            setStatus('No claimable amount available or no tokens owned');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');

            const t = treasury.connect(signer);
            let tx;

            if (userTokenIds.length === 1) {
                tx = await claimWithRetry(t, 'claim', [userTokenIds[0]]);
            } else {
                try {
                    tx = await claimWithRetry(t, 'claimMany', [userTokenIds]);
                } catch (e) {
                    debugWarn('claimMany failed; trying per token', e);
                    let okCount = 0;
                    for (const id of userTokenIds) {
                        try {
                            const singleTx = await claimWithRetry(t, 'claim', [id]);
                            if (singleTx) {
                                await singleTx.wait();
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
                setStatus('Transaction submitted, waiting confirmation...');
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
            if ((error.message || '').includes('native send fail')) {
                setStatus('Claim failed in treasury transfer (native send). Contract may lack balance or have a send bug.');
            } else if ((error.message || '').includes('insufficient funds')) {
                setStatus('Insufficient gas funds to claim.');
            } else if ((error.message || '').includes('user rejected')) {
                setStatus('Transaction cancelled.');
            } else {
                setStatus(`Claim failed: ${error.reason || error.message}`);
            }
        } finally {
            setClaiming(false);
        }
    }

    // ethers v6 gas estimation helpers (no TypeScript):
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
                        // ethers v6: contract.estimateGas.<fn>(...args)
                        const est = await contractWithSigner.estimateGas[method](...args);
                        const padded = (big(est) * 12n) / 10n; // +20%
                        overrides = { gasLimit: padded };
                        debugLog(`${method} gas est: ${est.toString()} -> using ${padded.toString()}`);
                    } catch (e) {
                        debugWarn('gas estimate failed, fallback fixed gas', e);
                        continue; // try next strategy
                    }
                } else {
                    overrides = { gasLimit: s.gasLimit };
                }
                const tx = await contractWithSigner[method](...args, overrides);
                return tx;
            } catch (e) {
                debugWarn(`${method} with strategy "${s.label}" failed`, e);
                if ((e.message || '').includes('native send fail')) throw e;
                if (i === strategies.length - 1) throw e;
            }
        }
    }

    // ---------- render ----------
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
                    <div>• Treasury Balance: {methodsWorking.totalRevenue ? '✅' : '❌'}</div>
                    <div>• Contract cumulativePerTokenX18: {methodsWorking.actualContract ? '✅' : '❌'}</div>
                </div>
            )}

            {wallet && treasury && (
                <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
                    <button
                        className="hp-btn hp-btn--secondary"
                        onClick={async () => {
                            setDataLoaded(false);
                            setStatus('Refreshing data...');
                            await loadUserData();
                            await loadTreasuryStats();
                            setStatus('');
                        }}
                        disabled={loading}
                        style={{ fontSize: '0.9rem', padding: '0.5rem 1rem', opacity: loading ? 0.6 : 1 }}
                    >
                        {loading ? 'Refreshing...' : '🔄 Refresh Data'}
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
                            {calculating ? 'Calculating...' : `${formatVTRU(claimableAmount)} VTRU`}
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
                            {claiming ? 'Claiming...' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
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
                        <div className="hp-mini__value">{formatVTRU(treasuryStats.totalRevenue)} VTRU</div>
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
                    Loading RevShare data...
                </div>
            )}
        </div>
    );
};

export default BlockSharePage;
