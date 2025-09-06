import React, { useEffect, useMemo, useState } from 'react';
import { ethers, Log } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

type MethodsState = {
    treasuryBalance: boolean;
    claimableCall: boolean;
    nftBalance: boolean;
    logsScanning: boolean;
    holdersScanning: boolean;
};

const BlockSharePage: React.FC = () => {
    const { wallet, signer, provider } = useWallet();

    const [treasury, setTreasury] = useState < any > (null);
    const [nft, setNft] = useState < any > (null);

    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [dataLoaded, setDataLoaded] = useState(false);

    const [methodsWorking, setMethodsWorking] = useState < MethodsState > ({
        treasuryBalance: false,
        claimableCall: false,
        nftBalance: false,
        logsScanning: false,
        holdersScanning: false,
    });

    // user
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState < number[] > ([]);
    const [userShares, setUserShares] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [userTotalClaimed, setUserTotalClaimed] = useState('0');

    // global
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        totalHolders: 0,
    });

    // env
    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS as string;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS as string;
    const STEP = Number(import.meta.env.VITE_LOG_SCAN_STEP || '50000'); // blocks per batch
    const TREASURY_START = useMemo(
        () => BigInt(import.meta.env.VITE_TREASURY_START_BLOCK || '0'),
        []
    );
    const NFT_START = useMemo(
        () => BigInt(import.meta.env.VITE_NFT_START_BLOCK || '0'),
        []
    );

    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) {
            initContracts();
        }
    }, [provider, treasuryAddress, nftAddress]);

    useEffect(() => {
        if (treasury && nft && wallet && !dataLoaded) {
            loadEverything();
        }
    }, [treasury, nft, wallet, dataLoaded]);

    const initContracts = async () => {
        try {
            setContractError('');
            const t = new ethers.Contract(treasuryAddress, RevShareTreasuryAbi.abi, provider);
            const n = new ethers.Contract(nftAddress, RevShareNFTAbi.abi, provider);

            const [tc, nc] = await Promise.all([provider.getCode(treasuryAddress), provider.getCode(nftAddress)]);
            if (tc === '0x') throw new Error('Treasury contract not found at address');
            if (nc === '0x') throw new Error('NFT contract not found at address');

            setTreasury(t);
            setNft(n);
            setDataLoaded(false);
        } catch (e: any) {
            const msg = `Failed to initialize RevShare contracts: ${e.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, e);
        }
    };

    const loadEverything = async () => {
        try {
            setLoading(true);

            // user balances + tokenIds
            await loadUserBasics();

            // claimables
            const c = await calcClaimable(userTokenIds);
            setClaimableAmount(c);

            // user total claimed: sum Claim / ClaimMany logs to this wallet
            const userClaimed = await calcUserTotalClaimed(wallet!);
            setUserTotalClaimed(userClaimed);

            // global stats
            await loadGlobalStats();

            setDataLoaded(true);
        } catch (e) {
            debugWarn('loadEverything error', e);
        } finally {
            setLoading(false);
        }
    };

    const loadUserBasics = async () => {
        if (!wallet || !nft) return;

        try {
            const bal = await nft.balanceOf(wallet);
            const n = Number(bal);
            setUserNFTBalance(n);
            setUserShares(n);
            setMethodsWorking((s) => ({ ...s, nftBalance: true }));

            const ids = await getUserTokenIds(wallet);
            setUserTokenIds(ids);
        } catch (e) {
            debugWarn('Failed to get user basics', e);
            setUserNFTBalance(0);
            setUserShares(0);
            setUserTokenIds([]);
            setMethodsWorking((s) => ({ ...s, nftBalance: false }));
        }
    };

    const getUserTokenIds = async (owner: string) => {
        if (!nft) return [];
        const out: number[] = [];
        try {
            const bal = Number(await nft.balanceOf(owner));
            if (bal === 0) return out;

            // try Enumerable
            try {
                nft.interface.getFunction('tokenOfOwnerByIndex');
                for (let i = 0; i < bal; i++) {
                    const id = await nft.tokenOfOwnerByIndex(owner, i);
                    out.push(Number(id));
                }
                return out;
            } catch {
                // fallback scan
                let total = 0;
                try {
                    total = Number(await nft.totalSupply());
                } catch {
                    total = 1500; // cap – safe fallback
                }
                for (let id = 1; id <= total && out.length < bal; id++) {
                    try {
                        const o = await nft.ownerOf(id);
                        if (o?.toLowerCase() === owner.toLowerCase()) out.push(id);
                    } catch { /* skip gaps */ }
                }
                return out;
            }
        } catch (e) {
            debugWarn('getUserTokenIds failed', e);
            return [];
        }
    };

    const calcClaimable = async (tokenIds: number[]) => {
        if (!treasury || tokenIds.length === 0) return '0';
        try {
            setCalculating(true);
            let sum = 0n;
            for (const id of tokenIds) {
                try {
                    const v = await treasury.claimable(BigInt(id));
                    sum += v;
                } catch (e) {
                    debugWarn(`claimable(${id}) failed`, e);
                }
            }
            const clean = Number(ethers.formatUnits(sum, 18)).toFixed(8).replace(/\.?0+$/, '');
            setMethodsWorking((s) => ({ ...s, claimableCall: true }));
            return clean;
        } catch (e) {
            debugWarn('calcClaimable failed', e);
            setMethodsWorking((s) => ({ ...s, claimableCall: false }));
            return '0';
        } finally {
            setCalculating(false);
        }
    };

    const loadGlobalStats = async () => {
        if (!treasury || !nft) return;

        try {
            // total revenue (native)
            let totalRevenue = '0';
            try {
                const bal = await provider!.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(bal);
                setMethodsWorking((s) => ({ ...s, treasuryBalance: true }));
            } catch (e) {
                debugWarn('getBalance failed', e);
                setMethodsWorking((s) => ({ ...s, treasuryBalance: false }));
            }

            // shares = totalSupply
            let totalShares = 0;
            try {
                totalShares = Number(await nft.totalSupply());
            } catch (e) {
                debugWarn('totalSupply failed', e);
            }

            // revenue/share from cumulativePerTokenX18
            let revenuePerShare = '0';
            try {
                const cpx18 = await treasury.cumulativePerTokenX18();
                revenuePerShare = Number(ethers.formatUnits(cpx18, 18)).toFixed(8).replace(/\.?0+$/, '');
            } catch {
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toFixed(8).replace(/\.?0+$/, '');
                }
            }

            // total holders from NFT Transfer logs
            const holders = await calcTotalHolders();
            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                totalHolders: holders,
            });
        } catch (e) {
            debugWarn('loadGlobalStats failed', e);
        }
    };

    // ---- LOG SCANNERS ----

    const ifaceTreasury = useMemo(() => new ethers.Interface(RevShareTreasuryAbi.abi), []);
    const ifaceNFT = useMemo(() => new ethers.Interface(RevShareNFTAbi.abi), []);

    const topicClaimed = useMemo(
        () => ethers.id('Claimed(uint256,address,uint256)'),
        []
    );
    const topicClaimedMany = useMemo(
        () => ethers.id('ClaimedMany(address,uint256,uint256)'),
        []
    );
    const topicTransfer = useMemo(
        () => ethers.id('Transfer(address,address,uint256)'),
        []
    );

    const getLatestBlock = async (): Promise<bigint> => {
        const n = await provider!.getBlockNumber();
        return BigInt(n);
    };

    const getLogsBatched = async (params: {
        address: string;
        topics: (string | string[] | null)[];
        fromBlock: bigint;
        toBlock: bigint;
    }) => {
        const res: Log[] = [];
        const step = BigInt(STEP);
        let start = params.fromBlock;
        const end = params.toBlock;

        while (start <= end) {
            const chunkEnd = start + step - 1n <= end ? start + step - 1n : end;
            const filter = {
                address: params.address,
                topics: params.topics,
                fromBlock: Number(start),
                toBlock: Number(chunkEnd),
            };
            try {
                const logs = await provider!.getLogs(filter);
                res.push(...logs);
            } catch (e) {
                // If provider rejects large ranges, fall back to smaller step
                debugWarn(`getLogs failed for ${start}-${chunkEnd}, reducing step`, e);
                // try halving step once
                const smallStep = step / 5n;
                if (smallStep < 1000n) throw e;
                for (let s = start; s <= chunkEnd; s += smallStep) {
                    const sEnd = s + smallStep - 1n <= chunkEnd ? s + smallStep - 1n : chunkEnd;
                    const f2 = {
                        address: params.address,
                        topics: params.topics,
                        fromBlock: Number(s),
                        toBlock: Number(sEnd),
                    };
                    try {
                        const logs2 = await provider!.getLogs(f2);
                        res.push(...logs2);
                    } catch (e2) {
                        debugWarn(`mini getLogs failed for ${s}-${sEnd}`, e2);
                    }
                }
            }
            start = chunkEnd + 1n;
        }
        return res;
    };

    // Sum of all amounts the current wallet has ever claimed (Claimed + ClaimedMany)
    const calcUserTotalClaimed = async (user: string) => {
        if (!treasury || !user) return '0';
        try {
            setMethodsWorking((s) => ({ ...s, logsScanning: true }));
            const latest = await getLatestBlock();

            // Claimed(tokenId indexed, to indexed, amount)
            const logs1 = await getLogsBatched({
                address: treasuryAddress,
                topics: [topicClaimed, null, ethers.zeroPadValue(user, 32)],
                fromBlock: TREASURY_START,
                toBlock: latest,
            });

            // ClaimedMany(to indexed, count, totalAmount)
            const logs2 = await getLogsBatched({
                address: treasuryAddress,
                topics: [topicClaimedMany, ethers.zeroPadValue(user, 32)],
                fromBlock: TREASURY_START,
                toBlock: latest,
            });

            let total = 0n;

            for (const l of logs1) {
                try {
                    const parsed = ifaceTreasury.parseLog(l);
                    // args: tokenId, to, amount
                    total += BigInt(parsed.args.amount);
                } catch (e) {
                    debugWarn('parse Claimed failed', e);
                }
            }

            for (const l of logs2) {
                try {
                    const parsed = ifaceTreasury.parseLog(l);
                    // args: to, count, totalAmount
                    total += BigInt(parsed.args.totalAmount);
                } catch (e) {
                    debugWarn('parse ClaimedMany failed', e);
                }
            }

            const clean = Number(ethers.formatUnits(total, 18)).toFixed(8).replace(/\.?0+$/, '');
            return clean;
        } catch (e) {
            debugWarn('calcUserTotalClaimed failed', e);
            return '0';
        } finally {
            setMethodsWorking((s) => ({ ...s, logsScanning: false }));
        }
    };

    // Approx total holders: replay balances from Transfer logs
    const calcTotalHolders = async () => {
        if (!nft) return 0;
        try {
            setMethodsWorking((s) => ({ ...s, holdersScanning: true }));
            const latest = await getLatestBlock();

            const logs = await getLogsBatched({
                address: nftAddress,
                topics: [topicTransfer],
                fromBlock: NFT_START,
                toBlock: latest,
            });

            const balances = new Map < string, number> ();
            const ZERO = '0x0000000000000000000000000000000000000000';

            for (const l of logs) {
                // Standard ERC721 Transfer(address,address,uint256)
                const from = '0x' + l.topics[1].slice(26).toLowerCase();
                const to = '0x' + l.topics[2].slice(26).toLowerCase();

                if (from !== ZERO) {
                    balances.set(from, (balances.get(from) || 0) - 1);
                }
                if (to !== ZERO) {
                    balances.set(to, (balances.get(to) || 0) + 1);
                }
            }

            let holders = 0;
            for (const [, bal] of balances) {
                if (bal > 0) holders++;
            }
            return holders;
        } catch (e) {
            debugWarn('calcTotalHolders failed, returning 0', e);
            return 0;
        } finally {
            setMethodsWorking((s) => ({ ...s, holdersScanning: false }));
        }
    };

    // ---- CLAIM ----

    const claimWithRetry = async (
        contract: any,
        method: 'claim' | 'claimMany',
        args: any[]
    ) => {
        const strategies = [
            { name: 'Standard', gasLimit: null as number | null },
            { name: 'High', gasLimit: 400_000 },
            { name: 'Very High', gasLimit: 600_000 },
            { name: 'Emergency', gasLimit: 800_000 },
        ];

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            try {
                let gasLimit: number;
                if (s.gasLimit) {
                    gasLimit = s.gasLimit;
                } else {
                    const estimated = await contract.estimateGas[method](...args);
                    gasLimit = Math.floor(Number(estimated) * 1.2);
                }
                return await contract[method](...args, { gasLimit });
            } catch (err: any) {
                if (String(err?.message || '').includes('native send fail')) throw err;
                if (i === strategies.length - 1) throw err;
            }
        }
    };

    const handleClaim = async () => {
        if (!signer || !treasury || calculating || !(parseFloat(claimableAmount) > 0) || userTokenIds.length === 0) {
            setStatus('No claimable amount available or no tokens owned');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');

            const c = treasury.connect(signer);
            let tx;

            if (userTokenIds.length === 1) {
                tx = await claimWithRetry(c, 'claim', [BigInt(userTokenIds[0])]);
            } else {
                try {
                    tx = await claimWithRetry(c, 'claimMany', [userTokenIds.map(BigInt)]);
                } catch (e) {
                    // fallback: individual
                    let ok = 0;
                    for (const id of userTokenIds) {
                        try {
                            const t = await claimWithRetry(c, 'claim', [BigInt(id)]);
                            await t.wait();
                            ok++;
                        } catch (e2) {
                            debugWarn(`claim(${id}) failed`, e2);
                        }
                    }
                    if (ok > 0) {
                        setStatus(`Revenue claimed for ${ok}/${userTokenIds.length} token(s).`);
                        setDataLoaded(false);
                        await loadEverything();
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
                    await loadEverything();
                    setTimeout(() => setStatus(''), 4000);
                } else {
                    setStatus('Transaction failed');
                }
            }
        } catch (error: any) {
            criticalError('Error claiming revenue:', error);
            if (String(error?.message || '').includes('native send fail')) {
                setStatus(
                    '🚨 Claim reverted in treasury (native send fail). Check contract balance and transfer logic; retry with more gas. If persistent, it is contract-level.'
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

    // ---- UI helpers ----

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
                    <p style={{ color: 'var(--hp-muted)' }}>Connect your wallet to view stats and claim earnings.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>🏛️ BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>
                    Track Blockdust marketplace revenue sharing and claim your earnings.
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

            {import.meta.env.VITE_DEBUG_MODE === 'true' && treasury && (
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
                    <div style={{ color: '#00d4ff', marginBottom: '0.5rem' }}>🔍 Debug</div>
                    <div>Treasury: {treasuryAddress}</div>
                    <div>NFT: {nftAddress}</div>
                    <div>Loaded: {dataLoaded ? '✅' : '❌'}</div>
                    <div>Loading: {loading ? '🔄' : '✅'}</div>
                    <div>Calculating: {calculating ? '🔄' : '✅'}</div>
                    <div>Token IDs: [{userTokenIds.join(', ')}]</div>
                    <div>Claimable: {claimableAmount} VTRU</div>
                    <div>Methods → balance: {methodsWorking.treasuryBalance ? '✅' : '❌'}</div>
                    <div>Methods → claimable(): {methodsWorking.claimableCall ? '✅' : '❌'}</div>
                    <div>Methods → nftBalance: {methodsWorking.nftBalance ? '✅' : '❌'}</div>
                    <div>Logs → user claims: {methodsWorking.logsScanning ? '🔄' : '✅ (done)'}</div>
                    <div>Logs → holders: {methodsWorking.holdersScanning ? '🔄' : '✅ (done)'}</div>
                    <div>Scan step: {STEP} blocks</div>
                    <div>Treasury start: {TREASURY_START.toString()}</div>
                    <div>NFT start: {NFT_START.toString()}</div>
                </div>
            )}

            {/* Refresh */}
            {wallet && treasury && (
                <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
                    <button
                        className="hp-btn hp-btn--secondary"
                        onClick={async () => {
                            setDataLoaded(false);
                            setStatus('Refreshing data...');
                            await loadEverything();
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
                                    ✅ From treasury claimable()
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Claimed (you)</div>
                        <div className="hp-mini__value">{formatVTRU(userTotalClaimed)} VTRU</div>
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
                        <div className="hp-mini__value">{treasuryStats.totalHolders.toLocaleString()}</div>
                    </div>
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
