import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareTreasuryActualAbi from '../abi/RevShareTreasuryActual.json';
import RevShareTreasuryMinimalAbi from '../abi/RevShareTreasuryMinimal.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();

    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;
    const DEBUG = import.meta.env.VITE_DEBUG_MODE === 'true';
    const COUNT_HOLDERS = import.meta.env.VITE_RS_COUNT_HOLDERS === 'true';
    const MAX_HOLDER_SCAN = parseInt(import.meta.env.VITE_RS_MAX_HOLDER_SCAN || '400', 10);

    const [treasury, setTreasury] = useState(null);
    const [treasuryActual, setTreasuryActual] = useState(null);
    const [treasuryMinimal, setTreasuryMinimal] = useState(null);
    const [activeTreasury, setActiveTreasury] = useState(null);
    const [nft, setNft] = useState(null);

    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [loading, setLoading] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [dataLoaded, setDataLoaded] = useState(false);

    const [methodsWorking, setMethodsWorking] = useState({
        totalRevenue: false,
        cumulativePerTokenX18: false,
        claimedPerTokenX18: false,
        claimable: false,
        claim: false,
        claimArray: false,
        claimMany: false,
        allocatePending: false,
        pendingBeforeMint: false,
        nft_totalSupply: false,
        nft_balanceOf: false,
        nft_tokenOfOwnerByIndex: false,
        nft_ownerOf: false
    });

    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userShares, setUserShares] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState([]);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [totalClaimed, setTotalClaimed] = useState('0');

    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        totalHolders: 0,
        pendingRevenue: '0'
    });

    const [detectedClaimSignatures, setDetectedClaimSignatures] = useState([]); // for debug

    const formatVTRU = (amount) => {
        if (typeof amount === 'string' && amount.length > 15 && !amount.includes('.') && !amount.includes('e')) {
            try {
                const formatted = ethers.formatUnits(amount, 18);
                const num = parseFloat(formatted);
                if (num === 0) return '0.0000';
                if (num < 0.0001) return '< 0.0001';
                return num.toFixed(4);
            } catch { }
        }
        const num = parseFloat(amount || '0');
        if (!isFinite(num) || num === 0) return '0.0000';
        if (num < 0.0001) return '< 0.0001';
        return num.toFixed(4);
    };
    const big = (v) => {
        try { return ethers.getBigInt(v); } catch { return BigInt(v); }
    };

    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) initContracts();
    }, [provider, treasuryAddress, nftAddress]);

    async function initContracts() {
        try {
            setContractError('');
            if (!treasuryAddress || !nftAddress) {
                const e = 'RevShare contract addresses not configured';
                setContractError(e);
                setStatus(e);
                return;
            }
            const full = new ethers.Contract(treasuryAddress, (RevShareTreasuryAbi.abi || RevShareTreasuryAbi), provider);
            const actual = new ethers.Contract(treasuryAddress, (RevShareTreasuryActualAbi.abi || RevShareTreasuryActualAbi), provider);
            const minimal = new ethers.Contract(treasuryAddress, (RevShareTreasuryMinimalAbi.abi || RevShareTreasuryMinimalAbi), provider);
            const nftCtr = new ethers.Contract(nftAddress, (RevShareNFTAbi.abi || RevShareNFTAbi), provider);

            const [tCode, nCode] = await Promise.all([provider.getCode(treasuryAddress), provider.getCode(nftAddress)]);
            if (tCode === '0x') throw new Error('Treasury contract not found at address');
            if (nCode === '0x') throw new Error('NFT contract not found at address');

            setTreasury(full);
            setTreasuryActual(actual);
            setTreasuryMinimal(minimal);
            setNft(nftCtr);

            // Choose the richest interface (has the most claim variants)
            const chosen = selectBestInterface([actual, full, minimal]);
            setActiveTreasury(chosen);

            await probeAvailability(chosen, nftCtr);
            setDataLoaded(false);
        } catch (err) {
            const msg = `Failed to initialize RevShare contracts: ${err.message}`;
            setContractError(msg);
            setStatus(msg);
            criticalError(msg, err);
        }
    }

    function selectBestInterface(list) {
        let best = list[0];
        let bestCount = 0;
        list.forEach(c => {
            if (!c?.interface) return;
            const count = c.interface.fragments.filter(f => f.type === 'function' && f.name.startsWith('claim')).length;
            if (count > bestCount) {
                best = c;
                bestCount = count;
            }
        });
        return best;
    }

    async function probeAvailability(t, n) {
        const m = { ...methodsWorking };
        const foundSigs = [];

        const claimFrags = t.interface.fragments.filter(f => f.type === 'function' && f.name === 'claim');
        claimFrags.forEach(f => {
            foundSigs.push(f.format());
            if (f.inputs.length === 1) {
                const type = f.inputs[0].type;
                if (type === 'uint256') m.claim = true;
                if (type === 'uint256[]') m.claimArray = true;
            }
        });

        const claimManyFrag = t.interface.fragments.find(f => f.type === 'function' && f.name === 'claimMany');
        if (claimManyFrag) {
            m.claimMany = true;
            foundSigs.push(claimManyFrag.format());
        }

        try { await t.cumulativePerTokenX18(); m.cumulativePerTokenX18 = true; } catch { }
        try { await t.claimedPerTokenX18(1); m.claimedPerTokenX18 = true; } catch { }
        try { await t.claimable(1); m.claimable = true; } catch { }
        try { await t.pendingBeforeMint(); m.pendingBeforeMint = true; } catch { }
        try { t.interface.getFunction('allocatePending'); m.allocatePending = true; } catch { }

        try { await n.totalSupply(); m.nft_totalSupply = true; } catch { }
        try { await n.balanceOf(ethers.ZeroAddress); m.nft_balanceOf = true; } catch { }
        try { await n.tokenOfOwnerByIndex(ethers.ZeroAddress, 0); m.nft_tokenOfOwnerByIndex = true; } catch { }
        try { await n.ownerOf(1); m.nft_ownerOf = true; } catch { }

        setMethodsWorking(m);
        setDetectedClaimSignatures(foundSigs);
    }

    useEffect(() => {
        if (activeTreasury && nft && wallet && !dataLoaded) {
            (async () => {
                await loadUserData();
                await loadTreasuryStats();
                setDataLoaded(true);
            })();
        }
    }, [activeTreasury, nft, wallet, dataLoaded]);

    async function loadUserData() {
        if (!wallet || !activeTreasury || !nft) return;
        try {
            setLoading(true);
            let bal = 0;
            try {
                const b = await nft.balanceOf(wallet);
                bal = parseInt(b.toString(), 10);
                setUserNFTBalance(bal);
                setUserShares(bal);
            } catch {
                setUserNFTBalance(0);
                setUserShares(0);
            }
            const ids = await getUserTokenIds(wallet);
            setUserTokenIds(ids);
            const claimable = await calcClaimable(ids);
            setClaimableAmount(claimable);
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
        if (!activeTreasury || !nft) return;
        try {
            let totalRevenue = '0';
            try {
                const bal = await provider.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(bal);
                setMethodsWorking(m => ({ ...m, totalRevenue: true }));
            } catch {
                setMethodsWorking(m => ({ ...m, totalRevenue: false }));
            }

            let totalShares = 0;
            try {
                const ts = await nft.totalSupply();
                totalShares = parseInt(ts.toString(), 10);
            } catch { }

            let pendingRevenue = '0';
            try {
                const pending = await activeTreasury.pendingBeforeMint();
                pendingRevenue = ethers.formatUnits(pending, 18);
                setMethodsWorking(m => ({ ...m, pendingBeforeMint: true }));
            } catch {
                setMethodsWorking(m => ({ ...m, pendingBeforeMint: false }));
            }

            let revenuePerShare = '0';
            try {
                const c = await activeTreasury.cumulativePerTokenX18();
                const per = ethers.formatUnits(c, 18);
                if (parseFloat(per) > 0) {
                    revenuePerShare = Number(per).toFixed(8).replace(/\.?0+$/, '');
                    setMethodsWorking(m => ({ ...m, cumulativePerTokenX18: true }));
                }
            } catch {
                setMethodsWorking(m => ({ ...m, cumulativePerTokenX18: false }));
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
                }
            }

            let totalHolders = 0;
            if (COUNT_HOLDERS) {
                totalHolders = await computeUniqueHolders(totalShares);
            }

            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                totalHolders,
                pendingRevenue
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
        for (let id = 1; id <= cap; id++) {
            try {
                const owner = await nft.ownerOf(id);
                owners.add(owner.toLowerCase());
            } catch { }
        }
        return owners.size;
    }

    async function getUserTokenIds(userAddr) {
        try {
            const balanceBN = await nft.balanceOf(userAddr);
            const balance = parseInt(balanceBN.toString(), 10);
            if (balance === 0) return [];
            try {
                const ids = [];
                for (let i = 0; i < balance; i++) {
                    const id = await nft.tokenOfOwnerByIndex(userAddr, i);
                    ids.push(parseInt(id.toString(), 10));
                }
                return ids;
            } catch {
                const ids = [];
                let ts = 0;
                try {
                    const t = await nft.totalSupply();
                    ts = parseInt(t.toString(), 10);
                } catch {
                    ts = 1200;
                }
                for (let tokenId = 1; tokenId <= ts && ids.length < balance; tokenId++) {
                    try {
                        const owner = await nft.ownerOf(tokenId);
                        if (owner.toLowerCase() === userAddr.toLowerCase()) ids.push(tokenId);
                    } catch { }
                }
                return ids;
            }
        } catch {
            return [];
        }
    }

    async function calcClaimable(tokenIds) {
        if (!activeTreasury || !tokenIds || tokenIds.length === 0) return '0';
        try {
            setCalculating(true);
            let totalX18 = big(0);
            let usedBuiltIn = false;
            try {
                for (const id of tokenIds) {
                    try {
                        const cAmt = await activeTreasury.claimable(id);
                        totalX18 += big(cAmt);
                        usedBuiltIn = true;
                    } catch { }
                }
                if (totalX18 > 0) {
                    setMethodsWorking(m => ({ ...m, claimable: true }));
                    return Number(ethers.formatUnits(totalX18, 18)).toFixed(8).replace(/\.?0+$/, '');
                }
            } catch { }

            if (!usedBuiltIn) setMethodsWorking(m => ({ ...m, claimable: false }));

            try {
                const c = await activeTreasury.cumulativePerTokenX18();
                totalX18 = big(0);
                for (const id of tokenIds) {
                    try {
                        const last = await activeTreasury.claimedPerTokenX18(id);
                        const delta = c - last;
                        if (delta > 0) totalX18 += delta;
                    } catch { }
                }
                if (totalX18 > 0) {
                    return Number(ethers.formatUnits(totalX18, 18)).toFixed(8).replace(/\.?0+$/, '');
                }
            } catch { }

            return '0';
        } finally {
            setCalculating(false);
        }
    }

    async function calcTotalClaimed(tokenIds) {
        if (!activeTreasury || !tokenIds || tokenIds.length === 0) return '0';
        try {
            let totalX18 = big(0);
            for (const id of tokenIds) {
                try {
                    const last = await activeTreasury.claimedPerTokenX18(id);
                    totalX18 += last;
                } catch { }
            }
            return Number(ethers.formatUnits(totalX18, 18)).toFixed(8).replace(/\.?0+$/, '');
        } catch {
            return '0';
        }
    }

    function resolveClaimExecution(ids) {
        // Decide which function to call based on availability and token count
        const multi = ids.length > 1;
        const hasSingle = methodsWorking.claim;
        const hasArrayClaim = methodsWorking.claimArray; // claim(uint256[])
        const hasClaimMany = methodsWorking.claimMany;

        // Priority:
        // 1. If multi and array version exists -> claim(uint256[])
        // 2. Else if multi and claimMany exists -> claimMany(uint256[])
        // 3. If single and single version exists -> claim(uint256)
        // 4. If single and only array version exists -> claim(uint256[]) with one element
        // 5. If multi and only single exists -> caller must loop
        if (multi) {
            if (hasArrayClaim) return { mode: 'array', signature: 'claim(uint256[])', batched: true };
            if (hasClaimMany) return { mode: 'claimMany', signature: 'claimMany(uint256[])', batched: true };
            if (hasSingle) return { mode: 'loop-single', signature: 'claim(uint256)', batched: false };
        } else {
            if (hasSingle) return { mode: 'single', signature: 'claim(uint256)', batched: false };
            if (hasArrayClaim) return { mode: 'array-single', signature: 'claim(uint256[])', batched: true };
        }
        return { mode: 'none', signature: 'none', batched: false };
    }

    async function simulateAndSend(contractWithSigner, modeInfo, ids) {
        const { mode } = modeInfo;
        if (mode === 'none') {
            throw new Error('No compatible claim function found in ABI (avoiding empty calldata tx).');
        }
        // Build args + function name (handling overload)
        let fn;
        let args;
        if (mode === 'single') {
            fn = 'claim';
            args = [ids[0]];
        } else if (mode === 'array' || mode === 'array-single') {
            // Need to disambiguate overload
            fn = 'claim(uint256[])';
            args = [ids];
        } else if (mode === 'claimMany') {
            fn = 'claimMany';
            args = [ids];
        } else if (mode === 'loop-single') {
            // Loop outside
            let success = 0;
            for (const id of ids) {
                const ok = await callOne(contractWithSigner, 'claim', [id]);
                if (ok) success++;
            }
            if (success === 0) throw new Error('All single claim calls reverted.');
            return { loopSucceeded: true, count: success };
        }

        // Simulate (callStatic)
        try {
            await contractWithSigner.callStatic[fn](...args);
        } catch (e) {
            debugWarn('Static simulation revert for', fn, args, e);
            throw new Error('Static simulation failed for ' + fn + ' (would revert).');
        }

        // Encode & ensure non-empty
        const data = contractWithSigner.interface.encodeFunctionData(fn, args);
        if (!data || data === '0x') {
            throw new Error('Encoded calldata empty for ' + fn + ' — aborting.');
        }
        debugLog(`Prepared claim call: fn=${fn} args=${JSON.stringify(args)} calldataLength=${data.length}`);

        // Gas estimate with padding
        let overrides = {};
        try {
            const est = await contractWithSigner.estimateGas[fn](...args);
            const padded = (big(est) * 12n) / 10n;
            overrides = { gasLimit: padded };
            debugLog(`Gas estimate for ${fn}: ${est.toString()} using padded ${padded.toString()}`);
        } catch (e) {
            debugWarn('Gas estimate failed; using fixed fallback 400k', e);
            overrides = { gasLimit: 400000n };
        }

        const tx = await contractWithSigner[fn](...args, overrides);
        return { tx };
    }

    async function callOne(contractWithSigner, fnName, args) {
        try {
            await contractWithSigner.callStatic[fnName](...args);
        } catch (e) {
            debugWarn(`Static failed for ${fnName}(${args})`, e);
            return false;
        }
        try {
            const est = await contractWithSigner.estimateGas[fnName](...args);
            const padded = (big(est) * 12n) / 10n;
            const tx = await contractWithSigner[fnName](...args, { gasLimit: padded });
            const rc = await tx.wait();
            return rc.status === 1;
        } catch (e) {
            debugWarn(`Send failed for ${fnName}(${args})`, e);
            return false;
        }
    }

    async function handleAllocatePending() {
        if (!signer || !activeTreasury || !methodsWorking.allocatePending) {
            setStatus('Allocate pending not available');
            return;
        }
        try {
            setStatus('Allocating pending revenue…');
            const t = activeTreasury.connect(signer);
            // Simulate first
            try { await t.callStatic.allocatePending(); } catch (e) {
                throw new Error('allocatePending would revert: ' + (e.reason || e.message));
            }
            const est = await t.estimateGas.allocatePending();
            const padded = (big(est) * 12n) / 10n;
            const tx = await t.allocatePending({ gasLimit: padded });
            setStatus('Transaction submitted…');
            const rc = await tx.wait();
            if (rc.status === 1) {
                setStatus('Pending revenue allocated.');
                setDataLoaded(false);
                await loadUserData();
                await loadTreasuryStats();
                setTimeout(() => setStatus(''), 4000);
            } else setStatus('Allocation failed');
        } catch (error) {
            criticalError('Error allocating pending revenue:', error);
            setStatus(`Allocation failed: ${(error.reason || error.message)}`);
        }
    }

    async function handleClaim() {
        if (!signer || !activeTreasury || calculating || parseFloat(claimableAmount) <= 0 || userTokenIds.length === 0) {
            setStatus('Nothing claimable');
            return;
        }
        try {
            setClaiming(true);
            setStatus('Resolving claim function…');
            const t = activeTreasury.connect(signer);

            const modeInfo = resolveClaimExecution(userTokenIds);
            debugLog('Claim execution strategy:', modeInfo);

            const result = await simulateAndSend(t, modeInfo, userTokenIds);

            if (result.loopSucceeded) {
                setStatus(`Claimed for ${result.count} tokens (loop single). Refreshing…`);
                setDataLoaded(false);
                await loadUserData();
                await loadTreasuryStats();
                setTimeout(() => setStatus(''), 4000);
                return;
            }

            if (result.tx) {
                setStatus('Tx submitted; waiting confirmation…');
                const rc = await result.tx.wait();
                if (rc.status === 1) {
                    setStatus('Revenue claimed successfully!');
                    setDataLoaded(false);
                    await loadUserData();
                    await loadTreasuryStats();
                    setTimeout(() => setStatus(''), 4000);
                } else {
                    setStatus('Claim transaction failed.');
                }
            }
        } catch (error) {
            criticalError('Error claiming revenue:', error);
            const msg = (error && (error.reason || error.message)) || 'Claim failed';
            if (msg.includes('empty calldata')) {
                setStatus('Refused to send empty calldata (ABI mismatch). Check contract ABI or function names.');
            } else if (msg.includes('revert')) {
                setStatus('Claim would revert (see console). Possibly no real claimable delta or allocation needed.');
            } else {
                setStatus(`Claim failed: ${msg}`);
            }
        } finally {
            setClaiming(false);
        }
    }

    if (!provider) {
        return (
            <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>BlockShare Revenue Portal</h2>
                    <p style={{ color: 'var(--hp-muted)' }}>Connect your wallet to continue.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>🏛️ BlockShare Revenue Portal</h2>
                <p style={{ color: 'var(--hp-muted)' }}>Track and claim your marketplace revenue share.</p>
            </div>

            {contractError && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: 8,
                    background: 'rgba(220,38,127,0.12)', border: '1px solid rgba(220,38,127,0.4)', color: '#ff6b6b'
                }}>
                    <strong>Contract Issue:</strong> {contractError}
                </div>
            )}
            {status && !contractError && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: 8,
                    background: 'rgba(85,51,255,0.12)', border: '1px solid rgba(85,51,255,0.4)'
                }}>
                    {status}
                </div>
            )}

            {DEBUG && activeTreasury && (
                <div style={{
                    padding: '1rem', marginBottom: '1.5rem', borderRadius: 8,
                    background: '#1e1e1e', border: '1px solid rgba(85,51,255,0.4)',
                    fontSize: '0.75rem', fontFamily: 'monospace', maxHeight: 400, overflow: 'auto'
                }}>
                    <div style={{ color: '#00d4ff', marginBottom: 8 }}>🔍 Debug</div>
                    <div>Treasury: {treasuryAddress}</div>
                    <div>NFT: {nftAddress}</div>
                    <div>Active ABI Claim Sigs: {detectedClaimSignatures.length ? detectedClaimSignatures.join(', ') : '—'}</div>
                    <div>Data Loaded: {dataLoaded ? '✅' : '❌'}</div>
                    <div>Token IDs: [{userTokenIds.join(', ')}]</div>
                    <div>Claimable: {claimableAmount} VTRU</div>
                    <div>Pending: {treasuryStats.pendingRevenue} VTRU</div>
                    <div style={{ marginTop: 6, color: '#ffeb3b' }}>Methods:</div>
                    <div>• claim(single): {methodsWorking.claim ? '✅' : '❌'}</div>
                    <div>• claim(array uint256[]): {methodsWorking.claimArray ? '✅' : '❌'}</div>
                    <div>• claimMany: {methodsWorking.claimMany ? '✅' : '❌'}</div>
                    <div>• allocatePending: {methodsWorking.allocatePending ? '✅' : '❌'}</div>
                    <div>• cumulativePerTokenX18: {methodsWorking.cumulativePerTokenX18 ? '✅' : '❌'}</div>
                    <div>• claimedPerTokenX18: {methodsWorking.claimedPerTokenX18 ? '✅' : '❌'}</div>
                    <div>• claimable(id): {methodsWorking.claimable ? '✅' : '❌'}</div>
                </div>
            )}

            {wallet && activeTreasury && (
                <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
                    <button
                        className="hp-btn hp-btn--secondary"
                        disabled={loading}
                        onClick={async () => {
                            setDataLoaded(false);
                            setStatus('Refreshing…');
                            await loadUserData();
                            await loadTreasuryStats();
                            setStatus('');
                        }}
                        style={{ marginRight: 12 }}
                    >
                        {loading ? 'Refreshing…' : '🔄 Refresh'}
                    </button>
                    {methodsWorking.allocatePending && parseFloat(treasuryStats.pendingRevenue) > 0 && (
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

            <div className="hp-section">
                <div className="hp-section__head"><h3>Your RevShare Stats</h3></div>
                <div className="hp-mini">
                    <Stat label="RevShare NFTs Owned" value={userNFTBalance.toLocaleString()} />
                    <Stat label="Your Shares" value={userShares.toLocaleString()} />
                    <Stat label="Claimable" value={`${formatVTRU(claimableAmount)} VTRU`} />
                    <Stat label="Total Claimed" value={`${formatVTRU(totalClaimed)} VTRU`} />
                </div>
                {wallet && !calculating && parseFloat(claimableAmount) > 0 && userTokenIds.length > 0 && (
                    <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                        <button
                            className="hp-btn hp-btn--primary"
                            onClick={handleClaim}
                            disabled={claiming}
                            style={{ fontSize: '1.05rem', padding: '0.7rem 2.2rem' }}
                        >
                            {claiming ? 'Claiming…' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
                        </button>
                    </div>
                )}
                {wallet && !calculating && parseFloat(claimableAmount) === 0 && (
                    <div style={{ marginTop: '1.2rem', textAlign: 'center', opacity: 0.7, fontStyle: 'italic' }}>
                        No revenue available to claim
                    </div>
                )}
            </div>

            <div className="hp-section">
                <div className="hp-section__head"><h3>Treasury Statistics</h3></div>
                <div className="hp-mini">
                    <Stat label="Total Revenue" value={`${formatVTRU(treasuryStats.totalRevenue)} VTRU`} />
                    <Stat label="Total Shares" value={treasuryStats.totalShares.toLocaleString()} />
                    <Stat label="Revenue / Share" value={`${formatVTRU(treasuryStats.revenuePerShare)} VTRU`} />
                    <Stat label="Total Holders" value={treasuryStats.totalHolders.toLocaleString()} />
                    {parseFloat(treasuryStats.pendingRevenue) > 0 && (
                        <Stat label="Pending Revenue" value={formatVTRU(treasuryStats.pendingRevenue) + ' VTRU'} highlight />
                    )}
                </div>
            </div>

            <div className="hp-section">
                <div className="hp-section__head"><h3>How It Works</h3></div>
                <div style={{ lineHeight: 1.55, opacity: 0.85 }}>
                    <p><strong>Revenue Sharing:</strong> Marketplace fees accrue, are allocated, then become claimable per NFT.</p>
                    <p><strong>Allocation Step:</strong> If pending revenue exists, an allocate action must run before claims rise.</p>
                    <p><strong>Claim:</strong> Once allocated, claim functions pull your proportional amount.</p>
                </div>
            </div>

            {loading && (
                <div style={{
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                    background: 'rgba(0,0,0,0.8)', padding: '2rem', borderRadius: 10, zIndex: 1000
                }}>
                    Loading data…
                </div>
            )}
        </div>
    );
};

function Stat({ label, value, highlight }) {
    return (
        <div className="hp-mini__card" style={highlight ? { borderColor: '#ffeb3b' } : undefined}>
            <div className="hp-mini__label">{label}</div>
            <div className="hp-mini__value" style={highlight ? { color: '#ffeb3b' } : undefined}>{value}</div>
        </div>
    );
}

export default BlockSharePage;