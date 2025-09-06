import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareTreasuryActualAbi from '../abi/RevShareTreasuryActual.json';
import RevShareTreasuryMinimalAbi from '../abi/RevShareTreasuryMinimal.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { convertToUSDCValue } from '../utils/tokenUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();
    const [treasuryContract, setTreasuryContract] = useState(null);
    const [treasuryActualContract, setTreasuryActualContract] = useState(null);
    const [treasuryMinimalContract, setTreasuryMinimalContract] = useState(null);
    const [nftContract, setNftContract] = useState(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [calculating, setCalculating] = useState(false);
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [dataLoaded, setDataLoaded] = useState(false);
    const [methodsWorking, setMethodsWorking] = useState({
        totalRevenue: false,
        getClaimableAmount: false,
        getUserShares: false,
        claim: false,
        actualContract: false
    });
    
    // User-specific data
    const [userShares, setUserShares] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [totalClaimed, setTotalClaimed] = useState('0');
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    const [userTokenIds, setUserTokenIds] = useState([]);
    
    // Global statistics
    const [treasuryStats, setTreasuryStats] = useState({
        totalRevenue: '0',
        totalShares: 0,
        revenuePerShare: '0',
        totalHolders: 0
    });

    const treasuryAddress = import.meta.env.VITE_REVSHARE_TREASURY_ADDRESS;
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;

    useEffect(() => {
        if (provider && treasuryAddress && nftAddress) {
            initializeContracts();
        }
    }, [provider, treasuryAddress, nftAddress]);

    // Test contract method availability 
    const testContractMethods = async () => {
        if (!treasuryContract || !provider) return;
        
        const methods = {
            totalRevenue: false,
            getClaimableAmount: false,
            getUserShares: false,
            getTotalClaimed: false,
            claim: false
        };
        
        debugLog('Testing contract methods availability...');
        
        // Test each method by trying to call it
        const testAddress = '0x0000000000000000000000000000000000000000';
        
        try {
            await treasuryContract.totalRevenue();
            methods.totalRevenue = true;
        } catch (e) {
            debugLog('totalRevenue() not available:', e.reason || e.message);
        }
        
        try {
            await treasuryContract.getClaimableAmount(testAddress);
            methods.getClaimableAmount = true;
        } catch (e) {
            debugLog('getClaimableAmount() not available:', e.reason || e.message);
        }
        
        try {
            await treasuryContract.getUserShares(testAddress);
            methods.getUserShares = true;
        } catch (e) {
            debugLog('getUserShares() not available:', e.reason || e.message);
        }
        
        try {
            await treasuryContract.getTotalClaimed(testAddress);
            methods.getTotalClaimed = true;
        } catch (e) {
            debugLog('getTotalClaimed() not available:', e.reason || e.message);
        }
        
        // For claim method, we can't actually call it, but we can check if it exists
        try {
            // Just check if the function exists by trying to encode it
            treasuryContract.interface.getFunction('claim');
            methods.claim = true;
        } catch (e) {
            debugLog('claim() not available:', e.reason || e.message);
        }
        
        debugLog('Contract method test results:', methods);
        return methods;
    };

    useEffect(() => {
        if (treasuryActualContract && import.meta.env.VITE_DEBUG_MODE === 'true') {
            testContractMethods();
        }
    }, [treasuryActualContract]);

    useEffect(() => {
        if (treasuryActualContract && nftContract && wallet && !dataLoaded) {
            loadUserData();
            loadTreasuryStats();
        }
    }, [treasuryActualContract, nftContract, wallet, dataLoaded]);

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
            const treasuryActual = new ethers.Contract(treasuryAddress, RevShareTreasuryActualAbi.abi, provider);
            const treasuryMinimal = new ethers.Contract(treasuryAddress, RevShareTreasuryMinimalAbi.abi, provider);
            const nft = new ethers.Contract(nftAddress, RevShareNFTAbi.abi, provider);
            
            // Test contract connectivity
            try {
                const treasuryCode = await provider.getCode(treasuryAddress);
                const nftCode = await provider.getCode(nftAddress);
                
                if (treasuryCode === '0x') {
                    throw new Error('Treasury contract not found at address');
                }
                if (nftCode === '0x') {
                    throw new Error('NFT contract not found at address');
                }
                
                debugLog('Both contracts verified on chain');
            } catch (error) {
                const errorMsg = `Contract verification failed: ${error.message}`;
                setContractError(errorMsg);
                setStatus(errorMsg);
                return;
            }
            
            setTreasuryContract(treasury);
            setTreasuryActualContract(treasuryActual);
            setTreasuryMinimalContract(treasuryMinimal);
            setNftContract(nft);
            setDataLoaded(false);
            debugLog('RevShare contracts initialized successfully');
        } catch (error) {
            const errorMsg = `Failed to initialize RevShare contracts: ${error.message}`;
            criticalError(errorMsg, error);
            setContractError(errorMsg);
            setStatus(errorMsg);
        }
    };

    const loadUserData = async () => {
        if (!wallet || !treasuryActualContract || !nftContract) return;
        
        try {
            setLoading(true);
            debugLog('Loading user RevShare data...');
            
            // Get user's NFT balance (determines shares)
            try {
                const nftBalance = await nftContract.balanceOf(wallet);
                const balanceNum = parseInt(nftBalance.toString());
                setUserNFTBalance(balanceNum);
                setUserShares(balanceNum); // Each NFT = 1 share
                debugLog('NFT balance loaded:', balanceNum);
            } catch (error) {
                debugWarn('Failed to get NFT balance:', error);
                setUserNFTBalance(0);
                setUserShares(0);
            }
            
            // Get user's token IDs
            const tokenIds = await getUserTokenIds(wallet);
            setUserTokenIds(tokenIds);
            debugLog('User token IDs:', tokenIds);
            
            // Calculate claimable amount using actual contract interface
            const claimable = await calculateActualClaimableAmount(wallet, tokenIds);
            setClaimableAmount(claimable);
            
            // Try to get total claimed (this might not exist in actual contract)
            try {
                let totalClaimedAmount = ethers.getBigInt(0);
                
                // Sum up claimed amounts for all user tokens
                for (const tokenId of tokenIds) {
                    try {
                        const claimedForToken = await treasuryActualContract.claimedPerTokenX18(tokenId);
                        totalClaimedAmount += claimedForToken;
                    } catch (tokenError) {
                        debugWarn(`Error getting claimed amount for token ${tokenId}:`, tokenError);
                    }
                }
                
                // Convert from X18 precision to ether using ethers.formatUnits
                const totalClaimedEther = ethers.formatUnits(totalClaimedAmount, 18);
                // Ensure we store a clean decimal string 
                const cleanTotalClaimed = Number(totalClaimedEther).toFixed(8).replace(/\.?0+$/, '');
                setTotalClaimed(cleanTotalClaimed);
                debugLog('Total claimed calculated:', cleanTotalClaimed);
            } catch (error) {
                debugWarn('Failed to calculate total claimed:', error);
                setTotalClaimed('0');
            }
            
            debugLog('User RevShare data loading completed');
            setDataLoaded(true);
        } catch (error) {
            criticalError('Error loading user RevShare data:', error);
            setStatus('Failed to load your RevShare data');
        } finally {
            setLoading(false);
        }
    };

    // Get user's token IDs 
    const getUserTokenIds = async (userAddress) => {
        if (!nftContract) return [];
        
        try {
            const balance = await nftContract.balanceOf(userAddress);
            const balanceNum = parseInt(balance.toString());
            
            if (balanceNum === 0) return [];
            
            const tokenIds = [];
            
            // Get token IDs by checking tokenOfOwnerByIndex if available
            try {
                for (let i = 0; i < balanceNum; i++) {
                    const tokenId = await nftContract.tokenOfOwnerByIndex(userAddress, i);
                    tokenIds.push(parseInt(tokenId.toString()));
                }
                debugLog('Token IDs loaded via tokenOfOwnerByIndex:', tokenIds);
                return tokenIds;
            } catch (error) {
                debugWarn('tokenOfOwnerByIndex not available, trying alternative method:', error);
            }
            
            // Fallback: try to find tokens by checking ownership of sequential IDs
            try {
                const totalSupply = await nftContract.totalSupply();
                const totalSupplyNum = parseInt(totalSupply.toString());
                
                for (let tokenId = 1; tokenId <= totalSupplyNum && tokenIds.length < balanceNum; tokenId++) {
                    try {
                        const owner = await nftContract.ownerOf(tokenId);
                        if (owner.toLowerCase() === userAddress.toLowerCase()) {
                            tokenIds.push(tokenId);
                        }
                    } catch (ownerError) {
                        // Token might not exist or be burned, continue
                    }
                }
                
                debugLog('Token IDs found via ownership check:', tokenIds);
                return tokenIds;
            } catch (supplyError) {
                debugWarn('Could not get total supply for token enumeration:', supplyError);
                return [];
            }
            
        } catch (error) {
            debugWarn('Error getting user token IDs:', error);
            return [];
        }
    };

    // Calculate claimable amount using actual contract interface
    const calculateActualClaimableAmount = async (userAddress, tokenIds) => {
        if (!treasuryActualContract || !tokenIds || tokenIds.length === 0) {
            return '0';
        }
        
        try {
            setCalculating(true);
            debugLog('Calculating claimable amount for tokens:', tokenIds);
            
            // Get cumulative per token distribution
            const cumulativePerTokenX18 = await treasuryActualContract.cumulativePerTokenX18();
            debugLog('Cumulative per token X18:', cumulativePerTokenX18.toString());
            
            let totalClaimable = ethers.getBigInt(0);
            
            // Calculate claimable amount for each token
            for (const tokenId of tokenIds) {
                try {
                    const claimedForToken = await treasuryActualContract.claimedPerTokenX18(tokenId);
                    const unclaimedForToken = cumulativePerTokenX18 - claimedForToken;
                    
                    if (unclaimedForToken > 0) {
                        totalClaimable += unclaimedForToken;
                    }
                    
                    debugLog(`Token ${tokenId}: cumulative=${cumulativePerTokenX18.toString()}, claimed=${claimedForToken.toString()}, unclaimed=${unclaimedForToken.toString()}`);
                } catch (tokenError) {
                    debugWarn(`Error getting data for token ${tokenId}:`, tokenError);
                }
            }
            
            // Convert from X18 precision to ether using ethers.formatUnits
            // Note: The contract uses X18 precision (18 decimals), so we use formatUnits with 18 decimals
            const claimableEther = ethers.formatUnits(totalClaimable, 18);
            debugLog('Total claimable amount calculated:', claimableEther, 'VTRU');
            debugLog('Raw totalClaimable:', totalClaimable.toString());
            
            // Ensure we return a properly formatted decimal string, not the raw BigInt
            // Use Number() instead of parseFloat() to handle edge cases better
            const cleanAmount = Number(claimableEther).toFixed(8).replace(/\.?0+$/, '');
            debugLog('Cleaned claimable amount:', cleanAmount);
            
            setMethodsWorking(prev => ({ ...prev, actualContract: true }));
            return cleanAmount;
            
        } catch (error) {
            debugWarn('Error calculating claimable amount with actual contract:', error);
            setMethodsWorking(prev => ({ ...prev, actualContract: false }));
            return '0';
        } finally {
            setCalculating(false);
        }
    };

    const loadTreasuryStats = async () => {
        if (!treasuryActualContract && !treasuryContract) return;
        
        try {
            debugLog('Loading treasury statistics...');
            
            let totalRevenue = '0';
            let totalShares = 0;
            let revenuePerShare = '0';
            let totalHolders = 0;
            
            // Get total revenue from contract balance (actual revenue deposited)
            try {
                const balance = await provider.getBalance(treasuryAddress);
                totalRevenue = ethers.formatEther(balance);
                debugLog('Treasury balance (total revenue):', totalRevenue);
                setMethodsWorking(prev => ({ ...prev, totalRevenue: true }));
            } catch (error) {
                debugWarn('Failed to get treasury balance:', error);
                setMethodsWorking(prev => ({ ...prev, totalRevenue: false }));
            }
            
            // Get total shares from NFT total supply
            try {
                if (nftContract) {
                    const totalSupply = await nftContract.totalSupply();
                    totalShares = parseInt(totalSupply.toString());
                    debugLog('Total shares (NFT supply):', totalShares);
                }
            } catch (error) {
                debugWarn('Failed to get NFT total supply:', error);
            }
            
            // Calculate revenue per share
            if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
                debugLog('Calculated revenue per share:', revenuePerShare);
            }
            
            // Try to get cumulative distribution info from actual contract
            try {
                if (treasuryActualContract) {
                    const cumulativePerTokenX18 = await treasuryActualContract.cumulativePerTokenX18();
                    // Convert from X18 precision to ether using ethers.formatUnits
                    const cumulativePerToken = ethers.formatUnits(cumulativePerTokenX18, 18);
                    debugLog('Cumulative per token distribution:', cumulativePerToken);
                    
                    // If there's cumulative distribution, use it as revenue per share
                    if (parseFloat(cumulativePerToken) > 0) {
                        // Ensure we store a clean decimal string, not the raw formatUnits result
                        revenuePerShare = Number(cumulativePerToken).toFixed(8).replace(/\.?0+$/, '');
                        debugLog('Using cumulative distribution as revenue per share:', revenuePerShare);
                    }
                }
            } catch (error) {
                debugWarn('Failed to get cumulative distribution:', error);
            }
            
            setTreasuryStats({
                totalRevenue,
                totalShares,
                revenuePerShare,
                totalHolders
            });
            
            debugLog('Treasury statistics loading completed');
        } catch (error) {
            debugWarn('Error loading treasury statistics:', error);
        }
    };

    const handleClaim = async () => {
        if (!signer || !treasuryActualContract || calculating || parseFloat(claimableAmount) <= 0 || userTokenIds.length === 0) {
            setStatus('No claimable amount available or no tokens owned');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');
            debugLog('Claiming revenue from treasury for tokens:', userTokenIds);
            
            const treasuryWithSigner = treasuryActualContract.connect(signer);
            
            let tx;
            if (userTokenIds.length === 1) {
                // Single token claim with enhanced gas handling
                debugLog('Claiming for single token:', userTokenIds[0]);
                tx = await claimWithRetry(treasuryWithSigner, 'claim', [userTokenIds[0]]);
            } else {
                // Multiple token claim with fallback to individual claims
                debugLog('Claiming for multiple tokens:', userTokenIds);
                try {
                    tx = await claimWithRetry(treasuryWithSigner, 'claimMany', [userTokenIds]);
                } catch (estimateError) {
                    debugWarn('ClaimMany failed, trying individual claims:', estimateError);
                    
                    // Fallback: claim each token individually
                    let successCount = 0;
                    for (const tokenId of userTokenIds) {
                        try {
                            const singleTx = await claimWithRetry(treasuryWithSigner, 'claim', [tokenId]);
                            if (singleTx) {
                                await singleTx.wait();
                                successCount++;
                                debugLog(`Successfully claimed for token ${tokenId}`);
                            }
                        } catch (singleError) {
                            debugWarn(`Failed to claim for token ${tokenId}:`, singleError);
                        }
                    }
                    
                    if (successCount > 0) {
                        setStatus(`Revenue claimed successfully for ${successCount}/${userTokenIds.length} tokens!`);
                        // Refresh user data
                        setDataLoaded(false);
                        await loadUserData();
                        await loadTreasuryStats();
                        
                        setTimeout(() => setStatus(''), 5000);
                        return;
                    } else {
                        throw new Error('Failed to claim for any tokens');
                    }
                }
            }
            
            if (tx) {
                setStatus('Transaction submitted, waiting for confirmation...');
                const receipt = await tx.wait();
                
                if (receipt.status === 1) {
                    setStatus('Revenue claimed successfully!');
                    // Refresh user data
                    setDataLoaded(false);
                    await loadUserData();
                    await loadTreasuryStats();
                    
                    setTimeout(() => setStatus(''), 5000);
                } else {
                    setStatus('Transaction failed');
                }
            }
            
        } catch (error) {
            criticalError('Error claiming revenue:', error);
            
            // Enhanced error handling for specific claim failures
            if (error.message.includes('native send fail')) {
                setStatus(`
🚨 Critical Treasury Issue: "Native Send Fail" Error

The treasury contract is unable to send VTRU tokens to your wallet. This is typically caused by:

• Treasury contract bug: The contract's native token transfer mechanism is failing
• Insufficient treasury balance: Contract may not have enough VTRU to send
• Gas limit issues: Transfer requires more gas than estimated
• Recipient address issue: Your wallet cannot receive native tokens

📋 Transaction Details from Trace:
• Function called: claim(${userTokenIds[0] || 'unknown'})
• Owner verification: ✅ Passed (you own the token)
• Transfer attempt: ❌ Failed with "native send fail"
• Contract balance: ${formatVTRU(treasuryStats.totalRevenue)} VTRU

💡 Recommended Actions:
1. Verify treasury contract has sufficient VTRU balance
2. Check if contract has a bug in native token sending logic
3. Try with higher gas limits (current strategies: Standard → High → Very High → Emergency)
4. Contact contract deployer about treasury transfer mechanism

This appears to be a contract-level issue that may require developer intervention.
                `.trim());
            } else if (error.message.includes('insufficient funds')) {
                setStatus('Transaction failed: Insufficient gas fees. Try increasing gas limit or add more VTRU to your wallet.');
            } else if (error.message.includes('user rejected')) {
                setStatus('Transaction cancelled by user');
            } else if (error.message.includes('gas')) {
                setStatus('Claim failed: Gas estimation failed. The treasury contract may have an issue with native token transfers.');
            } else {
                setStatus(`Claim failed: ${error.reason || error.message}`);
            }
        } finally {
            setClaiming(false);
        }
    };

    // Enhanced claim function with retry logic and gas handling
    const claimWithRetry = async (contract, method, args) => {
        const gasStrategies = [
            { name: 'Standard', gasLimit: null },
            { name: 'High', gasLimit: 400000 },
            { name: 'Very High', gasLimit: 600000 },
            { name: 'Emergency', gasLimit: 800000 }
        ];

        for (let i = 0; i < gasStrategies.length; i++) {
            const strategy = gasStrategies[i];
            
            try {
                debugLog(`Trying ${method} with ${strategy.name} gas strategy...`);
                
                let gasLimit;
                if (strategy.gasLimit) {
                    gasLimit = strategy.gasLimit;
                } else {
                    // Try to estimate gas
                    try {
                        const estimated = await contract[method].estimateGas(...args);
                        gasLimit = Math.floor(Number(estimated) * 1.2); // 20% buffer
                        debugLog(`Gas estimated: ${estimated}, using: ${gasLimit}`);
                    } catch (estimateError) {
                        debugWarn(`Gas estimation failed for ${strategy.name}:`, estimateError);
                        if (i === gasStrategies.length - 1) throw estimateError;
                        continue;
                    }
                }
                
                const tx = await contract[method](...args, { gasLimit });
                debugLog(`${method} transaction successful with ${strategy.name} strategy`);
                return tx;
                
            } catch (strategyError) {
                debugWarn(`${strategy.name} strategy failed:`, strategyError);
                
                if (strategyError.message.includes('native send fail')) {
                    // This is a contract-level issue, no point in retrying with different gas
                    throw strategyError;
                }
                
                if (i === gasStrategies.length - 1) {
                    // Last strategy failed, throw the error
                    throw strategyError;
                }
                
                // Continue to next strategy
                continue;
            }
        }
    };

    const formatVTRU = (amount) => {
        // Handle BigInt or very large string numbers that might be in wei
        if (typeof amount === 'string' && amount.length > 15 && !amount.includes('.') && !amount.includes('e')) {
            // This looks like a wei value (very long string without decimal or scientific notation)
            try {
                const formatted = ethers.formatUnits(amount, 18);
                const num = parseFloat(formatted);
                if (num === 0) return '0.0000';
                if (num < 0.0001) return '< 0.0001';
                return num.toFixed(4);
            } catch (error) {
                // If conversion fails, fall back to original logic
                console.warn('formatVTRU: Failed to convert potential wei value:', amount, error);
            }
        }
        
        const num = parseFloat(amount);
        if (num === 0) return '0.0000';
        if (num < 0.0001) return '< 0.0001';
        return num.toFixed(4);
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
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: 'rgba(220, 38, 127, 0.1)',
                    border: '1px solid rgba(220, 38, 127, 0.3)',
                    color: '#ff6b6b'
                }}>
                    <strong>⚠️ Contract Issue:</strong> {contractError}
                </div>
            )}

            {status && !contractError && (
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: 'rgba(85, 51, 255, 0.1)',
                    border: '1px solid rgba(85, 51, 255, 0.3)',
                    color: '#fff'
                }}>
                    {status}
                </div>
            )}

            {/* Debug Information Panel */}
            {import.meta.env.VITE_DEBUG_MODE === 'true' && treasuryActualContract && (
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: 'rgba(30, 30, 30, 0.8)',
                    border: '1px solid rgba(85, 51, 255, 0.3)',
                    fontSize: '0.85rem',
                    fontFamily: 'monospace'
                }}>
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
                    <div>• Treasury Balance: {methodsWorking.totalRevenue ? '✅' : '❌'}</div>
                    <div>• Actual Contract: {methodsWorking.actualContract ? '✅' : '❌'}</div>
                    <div>• NFT Balance: {userNFTBalance > 0 ? '✅' : '❌'}</div>
                    {methodsWorking.actualContract && parseFloat(claimableAmount) > 0 && (
                        <div style={{ marginTop: '0.5rem', color: '#00d4ff' }}>
                            ✅ Claimable calculation working with actual contract interface
                        </div>
                    )}
                    <div style={{ marginTop: '0.5rem', color: '#ff6b6b' }}>Treasury Health Check:</div>
                    <div>• Balance {`>`} 0: {parseFloat(treasuryStats.totalRevenue) > 0 ? '✅' : '❌'}</div>
                    <div>• Revenue per Share: {treasuryStats.revenuePerShare}</div>
                    <div>• Can Estimate Claim Gas: {parseFloat(claimableAmount) > 0 ? '⚠️ Unknown' : 'N/A'}</div>
                </div>
            )}

            {/* Manual Refresh Button */}
            {wallet && treasuryActualContract && (
                <div style={{ 
                    marginBottom: '1.5rem', 
                    textAlign: 'center' 
                }}>
                    <button 
                        className="hp-btn hp-btn--secondary"
                        onClick={() => {
                            setDataLoaded(false);
                            setStatus('Refreshing data...');
                            loadUserData();
                            loadTreasuryStats();
                        }}
                        disabled={loading}
                        style={{ 
                            fontSize: '0.9rem', 
                            padding: '0.5rem 1rem',
                            opacity: loading ? 0.6 : 1
                        }}
                    >
                        {loading ? 'Refreshing...' : '🔄 Refresh Data'}
                    </button>
                </div>
            )}

            {/* User Stats Section */}
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
                            {methodsWorking.actualContract && parseFloat(claimableAmount) > 0 && (
                                <div style={{ fontSize: '0.7rem', color: '#4ade80', marginTop: '0.2rem' }}>
                                    ✅ Calculated from contract
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Claimed</div>
                        <div className="hp-mini__value">{formatVTRU(totalClaimed)} VTRU</div>
                    </div>
                </div>

                {/* Claim Button */}
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
                    <div style={{ 
                        marginTop: '1.5rem', 
                        textAlign: 'center',
                        color: 'var(--hp-muted)',
                        fontStyle: 'italic' 
                    }}>
                        No revenue available to claim at this time
                    </div>
                )}
            </div>

            {/* Treasury Stats Section */}
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

            {/* How It Works Section */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>How BlockShare Works</h3>
                </div>
                <div style={{ color: 'var(--hp-muted)', lineHeight: 1.6 }}>
                    <p>
                        <strong>Revenue Sharing:</strong> A portion of marketplace fees is automatically distributed to RevShare NFT holders.
                    </p>
                    <p>
                        <strong>Your Share:</strong> Each RevShare NFT grants you shares in the revenue pool proportional to your holdings.
                    </p>
                    <p>
                        <strong>Claiming:</strong> Revenue accumulates over time and can be claimed anytime when available.
                    </p>
                    <p>
                        <strong>Mint RevShare NFTs:</strong> Visit the <a href="/mint" style={{ color: 'var(--hp-accent)' }}>Mint page</a> to acquire more RevShare NFTs and increase your revenue share.
                    </p>
                </div>
            </div>

            {loading && (
                <div style={{
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    background: 'rgba(0, 0, 0, 0.8)',
                    padding: '2rem',
                    borderRadius: '8px',
                    color: '#fff',
                    zIndex: 1000
                }}>
                    Loading RevShare data...
                </div>
            )}
        </div>
    );
};

export default BlockSharePage;