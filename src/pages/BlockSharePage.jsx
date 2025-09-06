import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareTreasuryAbi from '../abi/RevShareTreasury.json';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import { convertToUSDCValue } from '../utils/tokenUtils';

const BlockSharePage = () => {
    const { wallet, signer, provider } = useWallet();
    const [treasuryContract, setTreasuryContract] = useState(null);
    const [nftContract, setNftContract] = useState(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [status, setStatus] = useState('');
    
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

    useEffect(() => {
        if (treasuryContract && nftContract && wallet) {
            loadUserData();
            loadTreasuryStats();
        }
    }, [treasuryContract, nftContract, wallet]);

    const initializeContracts = async () => {
        try {
            debugLog('Initializing RevShare contracts...');
            const treasury = new ethers.Contract(treasuryAddress, RevShareTreasuryAbi.abi, provider);
            const nft = new ethers.Contract(nftAddress, RevShareNFTAbi.abi, provider);
            
            setTreasuryContract(treasury);
            setNftContract(nft);
            debugLog('RevShare contracts initialized successfully');
        } catch (error) {
            criticalError('Failed to initialize RevShare contracts:', error);
            setStatus('Failed to connect to RevShare contracts');
        }
    };

    const loadUserData = async () => {
        if (!wallet || !treasuryContract || !nftContract) return;
        
        try {
            setLoading(true);
            debugLog('Loading user RevShare data...');
            
            // Get user's NFT balance (determines shares)
            const nftBalance = await nftContract.balanceOf(wallet);
            setUserNFTBalance(parseInt(nftBalance.toString()));
            
            // Get user's shares in the treasury
            const shares = await treasuryContract.getUserShares(wallet);
            setUserShares(parseInt(shares.toString()));
            
            // Get claimable amount
            const claimable = await treasuryContract.getClaimableAmount(wallet);
            setClaimableAmount(ethers.formatEther(claimable));
            
            // Get total claimed by user
            const claimed = await treasuryContract.getTotalClaimed(wallet);
            setTotalClaimed(ethers.formatEther(claimed));
            
            debugLog('User RevShare data loaded successfully');
        } catch (error) {
            debugWarn('Error loading user RevShare data:', error);
            setStatus('Failed to load your RevShare data');
        } finally {
            setLoading(false);
        }
    };

    const loadTreasuryStats = async () => {
        if (!treasuryContract) return;
        
        try {
            debugLog('Loading treasury statistics...');
            
            const [totalRevenue, totalShares, revenuePerShare, totalHolders] = await Promise.all([
                treasuryContract.totalRevenue(),
                treasuryContract.totalShares(),
                treasuryContract.getRevenuePerShare(),
                treasuryContract.getTotalHolders()
            ]);
            
            setTreasuryStats({
                totalRevenue: ethers.formatEther(totalRevenue),
                totalShares: parseInt(totalShares.toString()),
                revenuePerShare: ethers.formatEther(revenuePerShare),
                totalHolders: parseInt(totalHolders.toString())
            });
            
            debugLog('Treasury statistics loaded successfully');
        } catch (error) {
            debugWarn('Error loading treasury statistics:', error);
        }
    };

    const handleClaim = async () => {
        if (!signer || !treasuryContract || parseFloat(claimableAmount) <= 0) {
            setStatus('No claimable amount available');
            return;
        }

        try {
            setClaiming(true);
            setStatus('Claiming revenue...');
            debugLog('Claiming revenue from treasury...');
            
            const treasuryWithSigner = treasuryContract.connect(signer);
            const tx = await treasuryWithSigner.claim();
            
            setStatus('Transaction submitted, waiting for confirmation...');
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                setStatus('Revenue claimed successfully!');
                // Refresh user data
                await loadUserData();
                await loadTreasuryStats();
                
                setTimeout(() => setStatus(''), 5000);
            } else {
                setStatus('Transaction failed');
            }
            
        } catch (error) {
            criticalError('Error claiming revenue:', error);
            setStatus(`Claim failed: ${error.message}`);
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

            {status && (
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
                        <div className="hp-mini__value">{formatVTRU(claimableAmount)} VTRU</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Claimed</div>
                        <div className="hp-mini__value">{formatVTRU(totalClaimed)} VTRU</div>
                    </div>
                </div>

                {/* Claim Button */}
                {wallet && parseFloat(claimableAmount) > 0 && (
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

                {wallet && parseFloat(claimableAmount) === 0 && (
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