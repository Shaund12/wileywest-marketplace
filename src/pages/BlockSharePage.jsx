import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareTreasuryMinimalAbi from '../abi/RevShareTreasuryMinimal.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { convertToUSDCValue } from '../utils/tokenUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();
    const [treasuryContract, setTreasuryContract] = useState(null);
    const [treasuryMinimalContract, setTreasuryMinimalContract] = useState(null);
    const [nftContract, setNftContract] = useState(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [status, setStatus] = useState('');
    const [contractError, setContractError] = useState('');
    const [dataLoaded, setDataLoaded] = useState(false);
    const [methodsWorking, setMethodsWorking] = useState({
        totalRevenue: false,
        getClaimableAmount: false,
        getUserShares: false,
        claim: false
    });
    
    // User-specific data
    const [userShares, setUserShares] = useState(0);
    const [claimableAmount, setClaimableAmount] = useState('0');
    const [totalClaimed, setTotalClaimed] = useState('0');
    const [userNFTBalance, setUserNFTBalance] = useState(0);
    
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
        if (treasuryContract && import.meta.env.VITE_DEBUG_MODE === 'true') {
            testContractMethods();
        }
    }, [treasuryContract]);

    useEffect(() => {
        if (treasuryContract && nftContract && wallet && !dataLoaded) {
            loadUserData();
            loadTreasuryStats();
        }
    }, [treasuryContract, nftContract, wallet, dataLoaded]);

    // Trigger manual calculation when we have all necessary data
    useEffect(() => {
        calculateClaimableAmountManually();
    }, [claimableAmount, userShares, treasuryStats.revenuePerShare, totalClaimed]);

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
        if (!wallet || !treasuryContract || !nftContract) return;
        
        try {
            setLoading(true);
            debugLog('Loading user RevShare data...');
            
            // Get user's NFT balance (determines shares)
            try {
                const nftBalance = await nftContract.balanceOf(wallet);
                setUserNFTBalance(parseInt(nftBalance.toString()));
                debugLog('NFT balance loaded:', nftBalance.toString());
            } catch (error) {
                debugWarn('Failed to get NFT balance:', error);
                setUserNFTBalance(0);
            }
            
            // Try to get user's shares in the treasury
            try {
                const shares = await treasuryContract.getUserShares(wallet);
                setUserShares(parseInt(shares.toString()));
                debugLog('User shares loaded:', shares.toString());
                setMethodsWorking(prev => ({ ...prev, getUserShares: true }));
            } catch (error) {
                debugWarn('Failed to get user shares (method may not exist):', error);
                // Fallback: if user has NFTs, assume 1 share per NFT
                setUserShares(userNFTBalance);
                setMethodsWorking(prev => ({ ...prev, getUserShares: false }));
            }
            
            // Try to get claimable amount
            try {
                const claimable = await treasuryContract.getClaimableAmount(wallet);
                setClaimableAmount(ethers.formatEther(claimable));
                debugLog('Claimable amount loaded:', ethers.formatEther(claimable));
                setMethodsWorking(prev => ({ ...prev, getClaimableAmount: true }));
            } catch (error) {
                debugWarn('Failed to get claimable amount (trying minimal ABI):', error);
                // Fallback to minimal contract
                try {
                    const claimable = await treasuryMinimalContract.getClaimableAmount(wallet);
                    setClaimableAmount(ethers.formatEther(claimable));
                    debugLog('Claimable amount loaded with minimal ABI:', ethers.formatEther(claimable));
                    setMethodsWorking(prev => ({ ...prev, getClaimableAmount: true }));
                } catch (minimalError) {
                    debugWarn('Failed to get claimable amount with minimal ABI, calculating manually:', minimalError);
                    // Manual calculation fallback: we'll calculate after getting treasury stats
                    setClaimableAmount('calculating');
                    setMethodsWorking(prev => ({ ...prev, getClaimableAmount: false }));
                }
            }
            
            // Get total claimed by user
            try {
                const claimed = await treasuryContract.getTotalClaimed(wallet);
                setTotalClaimed(ethers.formatEther(claimed));
                debugLog('Total claimed loaded:', ethers.formatEther(claimed));
            } catch (error) {
                debugWarn('Failed to get total claimed (method may not exist):', error);
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

    // Manual calculation for claimable amount when contract method fails
    const calculateClaimableAmountManually = () => {
        // Only calculate if the contract method failed and we have the necessary data
        if (claimableAmount === 'calculating' && 
            userShares > 0 && 
            treasuryStats.revenuePerShare && 
            parseFloat(treasuryStats.revenuePerShare) > 0) {
            
            const manualClaimable = userShares * parseFloat(treasuryStats.revenuePerShare) - parseFloat(totalClaimed);
            const calculatedAmount = Math.max(0, manualClaimable).toString();
            
            setClaimableAmount(calculatedAmount);
            debugLog('Manually calculated claimable amount:', calculatedAmount, 'VTRU');
            debugLog('Calculation: ', userShares, ' shares × ', treasuryStats.revenuePerShare, ' VTRU/share - ', totalClaimed, ' claimed = ', calculatedAmount);
        }
    };

    const loadTreasuryStats = async () => {
        if (!treasuryContract) return;
        
        try {
            debugLog('Loading treasury statistics...');
            
            let totalRevenue = '0';
            let totalShares = 0;
            let revenuePerShare = '0';
            let totalHolders = 0;
            
            // Try to get total revenue (most important stat)
            try {
                const revenue = await treasuryContract.totalRevenue();
                totalRevenue = ethers.formatEther(revenue);
                debugLog('Total revenue loaded:', totalRevenue);
                setMethodsWorking(prev => ({ ...prev, totalRevenue: true }));
            } catch (error) {
                debugWarn('Failed to get total revenue (trying minimal ABI):', error);
                // Fallback to minimal contract
                try {
                    const revenue = await treasuryMinimalContract.totalRevenue();
                    totalRevenue = ethers.formatEther(revenue);
                    debugLog('Total revenue loaded with minimal ABI:', totalRevenue);
                    setMethodsWorking(prev => ({ ...prev, totalRevenue: true }));
                } catch (minimalError) {
                    debugWarn('Failed to get total revenue with minimal ABI:', minimalError);
                    // Fallback: try to get contract balance directly
                    try {
                        const balance = await provider.getBalance(treasuryAddress);
                        totalRevenue = ethers.formatEther(balance);
                        debugLog('Using contract balance as revenue:', totalRevenue);
                        setMethodsWorking(prev => ({ ...prev, totalRevenue: 'fallback' }));
                    } catch (balanceError) {
                        debugWarn('Failed to get contract balance:', balanceError);
                        setMethodsWorking(prev => ({ ...prev, totalRevenue: false }));
                    }
                }
            }
            
            // Try to get total shares
            try {
                const shares = await treasuryContract.totalShares();
                totalShares = parseInt(shares.toString());
                debugLog('Total shares loaded:', totalShares);
            } catch (error) {
                debugWarn('Failed to get total shares (method may not exist):', error);
                // Fallback: try to get total supply from NFT contract if available
                try {
                    if (nftContract) {
                        const totalSupply = await nftContract.totalSupply();
                        totalShares = parseInt(totalSupply.toString());
                        debugLog('Using NFT total supply as shares:', totalShares);
                    }
                } catch (nftError) {
                    debugWarn('Failed to get NFT total supply:', nftError);
                }
            }
            
            // Try to get revenue per share
            try {
                const perShare = await treasuryContract.getRevenuePerShare();
                revenuePerShare = ethers.formatEther(perShare);
                debugLog('Revenue per share loaded:', revenuePerShare);
            } catch (error) {
                debugWarn('Failed to get revenue per share (method may not exist):', error);
                // Calculate manually if we have both values
                if (totalShares > 0 && parseFloat(totalRevenue) > 0) {
                    revenuePerShare = (parseFloat(totalRevenue) / totalShares).toString();
                    debugLog('Calculated revenue per share:', revenuePerShare);
                }
            }
            
            // Try to get total holders
            try {
                const holders = await treasuryContract.getTotalHolders();
                totalHolders = parseInt(holders.toString());
                debugLog('Total holders loaded:', totalHolders);
            } catch (error) {
                debugWarn('Failed to get total holders (method may not exist):', error);
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
        if (!signer || !treasuryContract || claimableAmount === 'calculating' || parseFloat(claimableAmount) <= 0) {
            setStatus('No claimable amount available');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');
            debugLog('Claiming revenue from treasury...');
            
            // Check if claim method exists
            try {
                const treasuryWithSigner = treasuryContract.connect(signer);
                
                // First try to estimate gas to see if the method works
                await treasuryWithSigner.claim.estimateGas();
                
                const tx = await treasuryWithSigner.claim();
                
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
                
            } catch (estimateError) {
                debugWarn('Claim with full ABI failed, trying minimal ABI:', estimateError);
                
                // Try with minimal contract
                try {
                    const treasuryMinimalWithSigner = treasuryMinimalContract.connect(signer);
                    
                    await treasuryMinimalWithSigner.claim.estimateGas();
                    const tx = await treasuryMinimalWithSigner.claim();
                    
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
                    
                } catch (minimalError) {
                    if (minimalError.message.includes('function does not exist')) {
                        setStatus('Claim function is not available on this contract');
                    } else {
                        throw minimalError;
                    }
                }
            }
            
        } catch (error) {
            criticalError('Error claiming revenue:', error);
            if (error.message.includes('insufficient funds')) {
                setStatus('Transaction failed: Insufficient gas fees');
            } else if (error.message.includes('user rejected')) {
                setStatus('Transaction cancelled by user');
            } else {
                setStatus(`Claim failed: ${error.message}`);
            }
        } finally {
            setClaiming(false);
        }
    };

    const formatVTRU = (amount) => {
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
            {import.meta.env.VITE_DEBUG_MODE === 'true' && treasuryContract && (
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
                    <div style={{ marginTop: '0.5rem', color: '#ffeb3b' }}>Contract Methods Status:</div>
                    <div>• totalRevenue(): {methodsWorking.totalRevenue === true ? '✅' : methodsWorking.totalRevenue === 'fallback' ? '⚠️ (using balance)' : '❌'}</div>
                    <div>• getClaimableAmount(): {methodsWorking.getClaimableAmount ? '✅' : '❌ (using manual calc)'}</div>
                    <div>• getUserShares(): {methodsWorking.getUserShares ? '✅' : '❌ (using NFT count)'}</div>
                    {!methodsWorking.getClaimableAmount && claimableAmount !== 'calculating' && claimableAmount !== '0' && (
                        <div style={{ marginTop: '0.5rem', color: '#00d4ff' }}>
                            Manual Calculation: {userShares} shares × {treasuryStats.revenuePerShare} VTRU/share - {totalClaimed} claimed = {claimableAmount} VTRU
                        </div>
                    )}
                </div>
            )}

            {/* Manual Refresh Button */}
            {wallet && treasuryContract && (
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
                            {claimableAmount === 'calculating' ? 'Calculating...' : `${formatVTRU(claimableAmount)} VTRU`}
                            {!methodsWorking.getClaimableAmount && claimableAmount !== 'calculating' && claimableAmount !== '0' && (
                                <div style={{ fontSize: '0.7rem', color: '#ffeb3b', marginTop: '0.2rem' }}>
                                    ⚠️ Manually calculated
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
                {wallet && claimableAmount !== 'calculating' && parseFloat(claimableAmount) > 0 && (
                    <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                        <button 
                            className="hp-btn hp-btn--primary"
                            onClick={handleClaim}
                            disabled={claiming || loading}
                            style={{ fontSize: '1.1rem', padding: '0.75rem 2rem' }}
                        >
                            {claiming ? 'Claiming...' : `Claim ${formatVTRU(claimableAmount)} VTRU`}
                        </button>
                        {!methodsWorking.getClaimableAmount && (
                            <div style={{ 
                                marginTop: '0.5rem', 
                                fontSize: '0.8rem', 
                                color: '#ffeb3b' 
                            }}>
                                ⚠️ Using manual calculation - verify amount before claiming
                            </div>
                        )}
                    </div>
                )}

                {wallet && claimableAmount !== 'calculating' && parseFloat(claimableAmount) === 0 && (
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