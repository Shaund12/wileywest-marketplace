import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
// import { convertToUSDCValue } from '../utils/tokenUtils'; // (optional, not used here)

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    const [treasuryContract, setTreasuryContract] = useState(null);
    const [nftContract, setNftContract] = useState(null);

    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [dataLoaded, setDataLoaded] = useState(false);

    const [methodsWorking, setMethodsWorking] = useState({
        treasuryBalance: false,
        claimableCall: false,
        nftBalance: false,
    });

    // User-specific data
    const [userShares, setUserShares] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState < number[] > ([]);

    // Global statistics
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        totalHolders: 0, // not computed on-chain with current contracts
    });

    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;

    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) {
            initializeContracts();
        }
    }, [provider, treasuryAddress, nftAddress]);

    useEffect(() => {
        if (treasuryContract && nftContract && wallet && !dataLoaded) {
            loadUserData();
            loadTreasuryStats();
        }
    }, [treasuryContract, nftContract, wallet, dataLoaded]);

    const initializeContracts = async () => {
        try {
            debugLog('Initializing RevShare contracts...');
            setContractError('');

            if (!treasuryAddress || !nftAddress) {
                const error = 'RevShare contract addresses not configured';
                setContractError(error);
                setStatus(error);
                return;
            }

            const treasury = new ethers.Contract(treasuryAddress, RevShareTreasuryAbi.abi, provider);
            const nft = new ethers.Contract(nftAddress, RevShareNFTAbi.abi, provider);

            // Test code presence on-chain
            const [treasuryCode, nftCode] = await Promise.all([
                provider.getCode(treasuryAddress),
                provider.getCode(nftAddress),
            ]);
            if (treasuryCode === '0x') throw new Error('Treasury contract not found at address');
            if (nftCode === '0x') throw new Error('NFT contract not found at address');

            setTreasuryContract(treasury);
            setNftContract(nft);
            setDataLoaded(false);

            debugLog('RevShare contracts initialized successfully');
        } catch (error: any) {
            const errorMsg = `Failed to initialize RevShare contracts: ${error.message}`;
            criticalError(errorMsg, error);
            setContractError(errorMsg);
            setStatus(errorMsg);
        }
    };

    const loadUserData = async () => {
        if (!wallet || !treasuryContract || !nftContract) return;

        try {
            setLoading(true);
            debugLog('Loading user RevShare data...');

            // Get user's NFT balance (1 NFT = 1 share)
            try {
                const nftBalance = await nftContract.balanceOf(wallet);
                const balanceNum = Number(nftBalance);
                setUserNFTBalance(balanceNum);
                setUserShares(balanceNum);
                setMethodsWorking(prev => ({ ...prev, nftBalance: true }));
                debugLog('NFT balance loaded:', balanceNum);
            } catch (error) {
                debugWarn('Failed to get NFT balance:', error);
                setUserNFTBalance(0);
                setUserShares(0);
                setMethodsWorking(prev => ({ ...prev, nftBalance: false }));
            }

            // Get user's token IDs
            const tokenIds = await getUserTokenIds(wallet);
            setUserTokenIds(tokenIds);
            debugLog('User token IDs:', tokenIds);

            // Calculate claimable amount using contract's own `claimable(tokenId)`
            const claimable = await calculateClaimableAmount(tokenIds);
            setClaimableAmount(claimable);

            debugLog('User RevShare data loading completed');
            setDataLoaded(true);
        } catch (error) {
            criticalError('Error loading user RevShare data:', error);
            setStatus('Failed to load your RevShare data');
        } finally {
            setLoading(false);
        }
    };

    // Get user's token IDs (works without ERC721Enumerable)
    const getUserTokenIds = async (userAddress: string) => {
        if (!nftContract) return [];

        try {
            const balance = await nftContract.balanceOf(userAddress);
            const balanceNum = Number(balance);
            if (balanceNum === 0) return [];

            const ids: number[] = [];

            // Try ERC721Enumerable if present
            try {
                // Will throw if fn doesn't exist
                nftContract.interface.getFunction('tokenOfOwnerByIndex');
                for (let i = 0; i < balanceNum; i++) {
                    const id = await nftContract.tokenOfOwnerByIndex(userAddress, i);
                    ids.push(Number(id));
                }
                debugLog('Token IDs via tokenOfOwnerByIndex:', ids);
                return ids;
            } catch {
                // Fallback: scan ownerOf across existing supply
                let totalSupply = 0;
                try {
                    totalSupply = Number(await nftContract.totalSupply());
                } catch (e) {
                    debugWarn('Could not get totalSupply; defaulting to scan up to 1500', e);
                    totalSupply = 1500; // safety cap
                }

                for (let tokenId = 1; tokenId <= totalSupply && ids.length < balanceNum; tokenId++) {
                    try {
                        const owner = await nftContract.ownerOf(tokenId);
                        if (owner?.toLowerCase() === userAddress.toLowerCase()) {
                            ids.push(tokenId);
                        }
                    } catch {
                        // non-existent token id; continue
                    }
                }
                debugLog('Token IDs via ownerOf scan:', ids);
                return ids;
            }
        } catch (error) {
            debugWarn('Error getting user token IDs:', error);
            return [];
        }
    };

    // Sum claimable amounts across owned tokens using the contract's view
    const calculateClaimableAmount = async (tokenIds: number[]) => {
        if (!treasuryContract || tokenIds.length === 0) return '0';
        try {
            setCalculating(true);
            debugLog('Calculating claimable amount for tokens:', tokenIds);

            let total = 0n;
            for (const id of tokenIds) {
                try {
                    const v = await treasuryContract.claimable(BigInt(id));
                    total += v;
                } catch (e) {
                    debugWarn(`claimable(${id}) failed:`, e);
                }
            }

            const clean = Number(ethers.formatUnits(total, 18))
                .toFixed(8)
                .replace(/\.?0+$/, '');
            setMethodsWorking(prev => ({ ...prev, claimableCall: true }));
            return clean;
        } catch (error) {
            debugWarn('Error calculating claimable amount:', error);
            setMethodsWorking(prev => ({ ...prev, claimableCall: false }));
            return '0';
        } finally {
            setCalculating(false);
        }
    };

    const loadTreasuryStats = async () => {
        if (!treasuryContract) return;

        try {
            debugLog('Loading treasury statistics...');

            let totalRevenue = '0';
            let totalShares = 0;
            let revenuePerShare = '0';

            // Treasury balance in native
            try {
                const balance = await provider.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(balance);
                setMethodsWorking(prev => ({ ...prev, treasuryBalance: true }));
            } catch (error) {
                debugWarn('Failed to get treasury balance:', error);
                setMethodsWorking(prev => ({ ...prev, treasuryBalance: false }));
            }

            // Total shares = NFT total supply
            try {
                if (nftContract) {
                    const totalSupply = await nftContract.totalSupply();
                    totalShares = Number(totalSupply);
                }
            } catch (error) {
                debugWarn('Failed to get NFT total supply:', error);
            }

            // Prefer on-chain cumulativePerTokenX18 for revenue/share if available
            try {
                const cpx18 = await treasuryContract.cumulativePerTokenX18();
                const perShare = ethers.formatUnits(cpx18, 18);
                revenuePerShare = Number(perShare).toFixed(8).replace(/\.?0+$/, '');
            } catch {
                // Fallback: rough average (not exact distribution)
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toFixed(8).replace(/\.?0+$/, '');
                }
            }

            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                totalHolders: 0, // not cheaply derivable without heavy scans
            });

            debugLog('Treasury statistics loading completed');
        } catch (error) {
            debugWarn('Error loading treasury statistics:', error);
        }
    };

    // Enhanced claim with ethers v6 gas estimation
    const claimWithRetry = async (contract: any, method: 'claim' | 'claimMany', args: any[]) => {
        const strategies = [
            { name: 'Standard', gasLimit: null as number | null },
            { name: 'High', gasLimit: 400_000 },
            { name: 'Very High', gasLimit: 600_000 },
            { name: 'Emergency', gasLimit: 800_000 },
        ];

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            try {
                debugLog(`Trying ${method} with ${s.name} gas strategy...`);

                let gasLimit: number;
                if (s.gasLimit) {
                    gasLimit = s.gasLimit;
                } else {
                    // ethers v6: estimateGas lives at contract.estimateGas[method](...)
                    const estimated = await contract.estimateGas[method](...args);
                    gasLimit = Math.floor(Number(estimated) * 1.2); // 20% buffer
                    debugLog(`Gas estimated: ${estimated.toString()}, using: ${gasLimit}`);
                }

                const tx = await contract[method](...args, { gasLimit });
                debugLog(`${method} transaction sent OK with ${s.name}`);
                return tx;
            } catch (err: any) {
                debugWarn(`${s.name} strategy failed:`, err);
                // If it's clearly a contract-level revert of transfer, bail early.
                if (String(err?.message || '').includes('native send fail')) throw err;
                if (i === strategies.length - 1) throw err; // last strategy: rethrow
            }
        }
    };

    const handleClaim = async () => {
        if (!signer || !treasuryContract || calculating || !(parseFloat(claimableAmount) > 0) || userTokenIds.length === 0) {
            setStatus('No claimable amount available or no tokens owned');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');
            debugLog('Claiming revenue from treasury for tokens:', userTokenIds);

            const c = treasuryContract.connect(signer);
            let tx;

            if (userTokenIds.length === 1) {
                tx = await claimWithRetry(c, 'claim', [BigInt(userTokenIds[0])]);
            } else {
                try {
                    tx = await claimWithRetry(c, 'claimMany', [userTokenIds.map(BigInt)]);
                } catch (batchErr) {
                    debugWarn('claimMany failed; attempting per-token fallback', batchErr);
                    let ok = 0;
                    for (const id of userTokenIds) {
                        try {
                            const t = await claimWithRetry(c, 'claim', [BigInt(id)]);
                            await t.wait();
                            ok++;
                        } catch (e) {
                            debugWarn(`claim(${id}) failed`, e);
                        }
                    }
                    if (ok > 0) {
                        setStatus(`Revenue claimed for ${ok}/${userTokenIds.length} token(s).`);
                        setDataLoaded(false);
                        await loadUserData();
                        await loadTreasuryStats();
                        setTimeout(() => setStatus(''), 4000);
                        return;
                    }
                    throw new Error('Failed to claim for any tokens');
                }
            }

            if (tx) {
                setStatus('Transaction submitted, waiting for confirmation...');
                const r = await tx.wait();
                if (r.status === 1) {
                    setStatus('Revenue claimed successfully!');
                    setDataLoaded(false);
                    await loadUserData();
                    await loadTreasuryStats();
                    setTimeout(() => setStatus(''), 4000);
                } else {
                    setStatus('Transaction failed');
                }
            }
        } catch (error: any) {
            criticalError('Error claiming revenue:', error);
            if (String(error?.message || '').includes('native send fail')) {
                setStatus(
                    [
                        '🚨 Claim failed: treasury native send reverted.',
                        '• Check treasury balance and transfer logic.',
                        '• Try again with more gas; if it persists, it is contract-level.',
                    ].join('\n')
                );
            } else if (String(error?.message || '').includes('insufficient funds')) {
                setStatus('Insufficient gas funds. Add VTRU and try again.');
            } else if (String(error?.message || '').match(/denied|rejected/i)) {
                setStatus('Transaction was cancelled.');
            } else {
                setStatus(`Claim failed: ${error?.reason || error?.message || 'Unknown error'}`);
            }
        } finally {
            setClaiming(false);
        }
    };

    const formatVTRU = (amount: string | number | bigint) => {
        try {
            if (typeof amount === 'bigint') {
                const f = Number(ethers.formatUnits(amount, 18));
                return f === 0 ? '0.0000' : f < 0.0001 ? '< 0.0001' : f.toFixed(4);
            }
            if (typeof amount === 'string' && amount.length > 15 && !amount.includes('.') && !amount.includes('e')) {
                const f = Number(ethers.formatUnits(amount, 18));
                return f === 0 ? '0.0000' : f < 0.0001 ? '< 0.0001' : f.toFixed(4);
            }
            const n = Number(amount);
            return n === 0 ? '0.0000' : n < 0.0001 ? '< 0.0001' : n.toFixed(4);
        } catch {
            const n = Number(amount);
            return isNaN(n) ? String(amount) : n.toFixed(4);
        }
    };

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
                <div
                    style={{
                        padding: '1rem',
                        marginBottom: '1.5rem',
                        borderRadius: '8px',
                        background: 'rgba(220, 38, 127, 0.1)',
                        border: '1px solid rgba(220, 38, 127, 0.3)',
                        color: '#ff6b6b',
                    }}
                >
                    <strong>⚠️ Contract Issue:</strong> {contractError}
                </div>
            )}

            {status && !contractError && (
                <div
                    style={{
                        whiteSpace: 'pre-wrap',
                        padding: '1rem',
                        marginBottom: '1.5rem',
                        borderRadius: '8px',
                        background: 'rgba(85, 51, 255, 0.1)',
                        border: '1px solid rgba(85, 51, 255, 0.3)',
                        color: '#fff',
                    }}
                >
                    {status}
                </div>
            )}

            {import.meta.env.VITE_DEBUG_MODE === 'true' && treasuryContract && (
                <div
                    style={{
                        padding: '1rem',
                        marginBottom: '1.5rem',
                        borderRadius: '8px',
                        background: 'rgba(30, 30, 30, 0.8)',
                        border: '1px solid rgba(85, 51, 255, 0.3)',
                        fontSize: '0.85rem',
                        fontFamily: 'monospace',
                    }}
                >
                    <div style={{ color: '#00d4ff', marginBottom: '0.5rem' }}>🔍 Debug Information</div>
                    <div>Treasury Address: {treasuryAddress}</div>
                    <div>NFT Address: {nftAddress}</div>
                    <div>Data Loaded: {dataLoaded ? '✅' : '❌'}</div>
                    <div>Loading: {loading ? '🔄' : '✅'}</div>
                    <div>Calculating: {calculating ? '🔄' : '✅'}</div>
                    <div>User Token IDs: [{userTokenIds.join(', ')}]</div>
                    <div>Raw Claimable Amount: {claimableAmount}</div>
                    <div>Formatted Claimable: {formatVTRU(claimableAmount)} VTRU</div>
                    <div style={{ marginTop: '0.5rem', color: '#ffeb3b' }}>Contract Methods Status:</div>
                    <div>• Treasury Balance: {methodsWorking.treasuryBalance ? '✅' : '❌'}</div>
                    <div>• claimable(): {methodsWorking.claimableCall ? '✅' : '❌'}</div>
                    <div>• NFT Balance: {methodsWorking.nftBalance ? '✅' : '❌'}</div>
                </div>
            )}

            {wallet && treasuryContract && (
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
                            {parseFloat(claimableAmount) > 0 && (
                                <div style={{ fontSize: '0.7rem', color: '#4ade80', marginTop: '0.2rem' }}>
                                    ✅ Calculated from contract claimable()
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Claimed</div>
                        <div className="hp-mini__value">—</div>
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
                    <div
                        style={{
                            marginTop: '1.5rem',
                            textAlign: 'center',
                            color: 'var(--hp-muted)',
                            fontStyle: 'italic',
                        }}
                    >
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
                        <div className="hp-mini__label">Total Revenue</div>
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
                        <div className="hp-mini__value">—</div>
                    </div>
                </div>
            </div>

            {/* How It Works */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>How BlockShare Works</h3>
                </div>
                <div style={{ color: 'var(--hp-muted)', lineHeight: 1.6 }}>
                    <p>
                        <strong>Revenue Sharing:</strong> A portion of marketplace fees is automatically distributed to RevShare NFT
                        holders.
                    </p>
                    <p>
                        <strong>Your Share:</strong> Each RevShare NFT grants you shares in the revenue pool proportional to your
                        holdings.
                    </p>
                    <p>
                        <strong>Claiming:</strong> Revenue accumulates over time and can be claimed anytime when available.
                    </p>
                    <p>
                        <strong>Mint RevShare NFTs:</strong> Visit the{' '}
                        <a href="/mint" style={{ color: 'var(--hp-accent)' }}>
                            Mint page
                        </a>{' '}
                        to acquire more RevShare NFTs and increase your revenue share.
                    </p>
                </div>
            </div>

            {loading && (
                <div
                    style={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'rgba(0, 0, 0, 0.8)',
                        padding: '2rem',
                        borderRadius: '8px',
                        color: '#fff',
                        zIndex: 1000,
                    }}
                >
                    Loading RevShare data...
                </div>
            )}
        </div>
    );
};

export default BlockSharePage;
