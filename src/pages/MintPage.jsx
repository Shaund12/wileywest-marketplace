import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareNFTAbi from '../abi/RevShareNFT.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';

const MintPage = () => {
    const { wallet, signer, provider } = useWallet();
    const [nftContract, setNftContract] = useState(null);
    const [loading, setLoading] = useState(false);
    const [minting, setMinting] = useState(false);
    const [status, setStatus] = useState('');
    
    // Contract data
    const [mintPrice, setMintPrice] = useState('0');
    const [totalSupply, setTotalSupply] = useState(0);
    const [maxSupply, setMaxSupply] = useState(0);
    const [saleActive, setSaleActive] = useState(false);
    const [userBalance, setUserBalance] = useState(0);
    const [userTokens, setUserTokens] = useState([]);
    const [payoutAddress, setPayoutAddress] = useState('');
    const [contractHealthy, setContractHealthy] = useState(true);
    const [contractDiagnostics, setContractDiagnostics] = useState(null);

    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_ADDRESS;

    useEffect(() => {
        if (provider && nftAddress) {
            initializeContract();
        }
    }, [provider, nftAddress]);

    useEffect(() => {
        if (nftContract) {
            loadContractData();
            if (wallet) {
                loadUserData();
            }
        }
    }, [nftContract, wallet]);

    const initializeContract = async () => {
        try {
            debugLog('Initializing RevShare NFT contract...');
            const contract = new ethers.Contract(nftAddress, RevShareNFTAbi.abi, provider);
            setNftContract(contract);
            debugLog('RevShare NFT contract initialized successfully');
        } catch (error) {
            criticalError('Failed to initialize RevShare NFT contract:', error);
            setStatus('Failed to connect to RevShare NFT contract');
        }
    };

    const loadContractData = async () => {
        if (!nftContract) return;
        
        try {
            setLoading(true);
            debugLog('Loading contract data...');
            
            const [price, total, max, active, payout] = await Promise.all([
                nftContract.mintPrice(),
                nftContract.totalSupply(),
                nftContract.MAX_SUPPLY(),
                nftContract.saleActive(),
                nftContract.payout()
            ]);
            
            setMintPrice(ethers.formatEther(price));
            setTotalSupply(parseInt(total.toString()));
            setMaxSupply(parseInt(max.toString()));
            setSaleActive(active);
            setPayoutAddress(payout);
            
            // Enhanced contract health checking
            await performContractDiagnostics(payout, active, price);
            
            debugLog('Contract data loaded successfully');
        } catch (error) {
            debugWarn('Error loading contract data:', error);
            setStatus('Failed to load contract information');
            setContractHealthy(false);
            setContractDiagnostics({
                error: true,
                message: 'Failed to load contract data',
                details: error.message
            });
        } finally {
            setLoading(false);
        }
    };

    const performContractDiagnostics = async (payout, active, price) => {
        const diagnostics = {
            payoutAddressValid: false,
            saleActive: active,
            priceValid: false,
            gasEstimationWorks: false,
            contractCallable: true,
            payoutAddressBalance: '0',
            recommendations: []
        };

        try {
            // Check payout address
            const isZeroAddress = payout === '0x0000000000000000000000000000000000000000';
            diagnostics.payoutAddressValid = !isZeroAddress;
            
            if (isZeroAddress) {
                diagnostics.recommendations.push('Contract payout address is set to zero address');
            }

            // Check if payout address can receive ETH (if not zero address)
            if (!isZeroAddress && provider) {
                try {
                    const balance = await provider.getBalance(payout);
                    diagnostics.payoutAddressBalance = ethers.formatEther(balance);
                    debugLog(`Payout address ${payout} balance: ${diagnostics.payoutAddressBalance} VTRU`);
                } catch (error) {
                    debugWarn('Could not check payout address balance:', error);
                }
            }

            // Check price validity
            diagnostics.priceValid = price > 0;
            
            if (!diagnostics.priceValid) {
                diagnostics.recommendations.push('Mint price is set to 0, which may cause issues');
            }

            // Test gas estimation for mint (only if sale is active and we have a wallet)
            if (active && signer && diagnostics.payoutAddressValid && diagnostics.priceValid) {
                try {
                    const contractWithSigner = nftContract.connect(signer);
                    const mintPriceWei = ethers.parseEther(ethers.formatEther(price));
                    
                    // Try to estimate gas - this will fail if payout mechanism has issues
                    await contractWithSigner.mint.estimateGas(1, { value: mintPriceWei });
                    diagnostics.gasEstimationWorks = true;
                    debugLog('Gas estimation test passed - contract appears healthy');
                } catch (error) {
                    diagnostics.gasEstimationWorks = false;
                    debugWarn('Gas estimation test failed:', error);
                    
                    if (error.message.includes('payout fail')) {
                        diagnostics.recommendations.push('Contract payout mechanism is failing - this may be a contract bug or configuration issue');
                    } else if (error.message.includes('insufficient funds')) {
                        // This is actually good - it means gas estimation worked but user doesn't have enough ETH
                        diagnostics.gasEstimationWorks = true;
                        diagnostics.recommendations.push('Gas estimation works, but you need more VTRU for minting');
                    } else {
                        diagnostics.recommendations.push(`Contract error during gas estimation: ${error.message}`);
                    }
                }
            }

            // Determine overall health
            const isHealthy = diagnostics.payoutAddressValid && 
                             diagnostics.saleActive && 
                             diagnostics.priceValid && 
                             diagnostics.gasEstimationWorks;
            
            setContractHealthy(isHealthy);
            setContractDiagnostics(diagnostics);
            
            if (!isHealthy) {
                debugWarn('Contract health check failed:', diagnostics);
            }
            
        } catch (error) {
            debugWarn('Error during contract diagnostics:', error);
            diagnostics.contractCallable = false;
            diagnostics.recommendations.push('Contract is not responding to calls');
            setContractHealthy(false);
            setContractDiagnostics(diagnostics);
        }
    };

    const loadUserData = async () => {
        if (!wallet || !nftContract) return;
        
        try {
            debugLog('Loading user NFT data...');
            
            // Get user's NFT balance
            const balance = await nftContract.balanceOf(wallet);
            const balanceNum = parseInt(balance.toString());
            setUserBalance(balanceNum);
            
            // Get user's token IDs
            const tokens = [];
            for (let i = 0; i < balanceNum; i++) {
                try {
                    const tokenId = await nftContract.tokenOfOwnerByIndex(wallet, i);
                    tokens.push(parseInt(tokenId.toString()));
                } catch (error) {
                    debugWarn(`Error getting token ${i}:`, error);
                }
            }
            setUserTokens(tokens);
            
            debugLog('User NFT data loaded successfully');
        } catch (error) {
            debugWarn('Error loading user NFT data:', error);
        }
    };

    const handleMint = async () => {
        if (!signer || !nftContract) {
            setStatus('Please connect your wallet');
            return;
        }

        if (!saleActive) {
            setStatus('Minting is not currently active');
            return;
        }

        if (totalSupply >= maxSupply) {
            setStatus('All RevShare NFTs have been minted');
            return;
        }

        try {
            setMinting(true);
            setStatus('Preparing mint transaction...');
            debugLog('Minting RevShare NFT...');
            
            const contractWithSigner = nftContract.connect(signer);
            const mintPriceWei = ethers.parseEther(mintPrice);
            
            // Enhanced pre-flight checks
            setStatus('Running pre-flight diagnostics...');
            await performContractDiagnostics(payoutAddress, saleActive, ethers.parseEther(mintPrice));
            
            if (!contractHealthy) {
                setStatus('Contract health check failed. Please see diagnostics below.');
                return;
            }
            
            // Estimate gas for the mint function (minting 1 NFT)
            setStatus('Estimating gas for mint transaction...');
            let gasEstimate;
            try {
                gasEstimate = await contractWithSigner.mint.estimateGas(1, { value: mintPriceWei });
                debugLog('Gas estimation successful:', gasEstimate.toString());
            } catch (gasError) {
                criticalError('Gas estimation failed:', gasError);
                
                // Enhanced error handling with more specific messages
                if (gasError.message.includes('payout fail')) {
                    setStatus('❌ Contract Error: The minting payout mechanism is failing. This appears to be a contract-level issue that needs to be resolved by the contract administrator. Please contact support with this error.');
                    
                    // Log detailed diagnostic information
                    debugLog('Payout fail diagnostics:', {
                        payoutAddress,
                        saleActive,
                        mintPrice,
                        totalSupply,
                        maxSupply,
                        diagnostics: contractDiagnostics
                    });
                    
                    return;
                } else if (gasError.message.includes('sale not active')) {
                    setStatus('Minting is not currently active');
                    return;
                } else if (gasError.message.includes('max supply reached')) {
                    setStatus('All RevShare NFTs have been minted');
                    return;
                } else if (gasError.message.includes('insufficient payment')) {
                    setStatus('Insufficient payment amount. Please check the mint price.');
                    return;
                } else if (gasError.message.includes('insufficient funds')) {
                    setStatus('Insufficient VTRU balance to mint. You need more VTRU in your wallet.');
                    return;
                } else {
                    setStatus(`Contract error: ${gasError.reason || gasError.message}`);
                    return;
                }
            }
            
            const gasLimit = gasEstimate * 120n / 100n; // 20% buffer
            
            setStatus('Sending mint transaction...');
            debugLog('Sending mint transaction with gas limit:', gasLimit.toString());
            
            const tx = await contractWithSigner.mint(1, {
                value: mintPriceWei,
                gasLimit: gasLimit
            });
            
            setStatus('Transaction submitted, waiting for confirmation...');
            debugLog('Transaction hash:', tx.hash);
            
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                // Find the token ID from the Transfer event
                const transferEvent = receipt.logs.find(log => {
                    try {
                        const parsed = nftContract.interface.parseLog(log);
                        return parsed && parsed.name === 'Transfer';
                    } catch {
                        return false;
                    }
                });
                
                let tokenId = 'Unknown';
                if (transferEvent) {
                    const parsed = nftContract.interface.parseLog(transferEvent);
                    tokenId = parsed.args.tokenId.toString();
                }
                
                setStatus(`✅ Successfully minted RevShare NFT #${tokenId}!`);
                debugLog('Mint successful! Token ID:', tokenId);
                
                // Refresh data
                await loadContractData();
                await loadUserData();
                
                setTimeout(() => setStatus(''), 8000);
            } else {
                setStatus('❌ Mint transaction failed');
                debugWarn('Transaction failed with status:', receipt.status);
            }
            
        } catch (error) {
            criticalError('Error minting NFT:', error);
            
            // Enhanced error messages
            if (error.code === 'INSUFFICIENT_FUNDS') {
                setStatus('❌ Insufficient VTRU balance to mint');
            } else if (error.message.includes('user rejected')) {
                setStatus('⚠️ Transaction cancelled by user');
            } else if (error.message.includes('payout fail')) {
                setStatus('❌ Contract Error: Mint payout mechanism is currently failing. This is a contract-level issue - please contact the contract administrator.');
            } else if (error.code === 'NETWORK_ERROR') {
                setStatus('❌ Network error. Please check your connection and try again.');
            } else if (error.code === 'TIMEOUT') {
                setStatus('❌ Transaction timeout. Please try again with higher gas.');
            } else {
                setStatus(`❌ Mint failed: ${error.reason || error.message}`);
            }
        } finally {
            setMinting(false);
        }
    };

    const formatVTRU = (amount) => {
        const num = parseFloat(amount);
        if (num === 0) return '0.0000';
        if (num < 0.0001) return '< 0.0001';
        return num.toFixed(4);
    };

    const getProgressPercentage = () => {
        if (maxSupply === 0) return 0;
        return Math.min((totalSupply / maxSupply) * 100, 100);
    };

    if (!provider) {
        return (
            <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Mint BlockDust RevShare NFT</h2>
                    <p style={{ color: 'var(--hp-muted)' }}>
                        Connect your wallet to mint BlockDust RevShare NFTs and earn marketplace revenue.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>⚡ Mint BlockDust RevShare NFT</h2>
                <p style={{ color: 'var(--hp-muted)' }}>
                    Mint RevShare NFTs to receive a portion of BlockDust marketplace revenue automatically.
                </p>
            </div>

            {status && (
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: status.includes('Successfully') 
                        ? 'rgba(34, 197, 94, 0.1)' 
                        : status.includes('failed') || status.includes('Error') || status.includes('Contract error')
                        ? 'rgba(239, 68, 68, 0.1)'
                        : 'rgba(85, 51, 255, 0.1)',
                    border: `1px solid ${status.includes('Successfully') 
                        ? 'rgba(34, 197, 94, 0.3)' 
                        : status.includes('failed') || status.includes('Error') || status.includes('Contract error')
                        ? 'rgba(239, 68, 68, 0.3)'
                        : 'rgba(85, 51, 255, 0.3)'}`,
                    color: '#fff'
                }}>
                    {status}
                </div>
            )}

            {/* Contract Health Warning */}
            {!contractHealthy && !loading && (
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#fff'
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
                        ⚠️ Contract Configuration Issue
                    </div>
                    <div style={{ fontSize: '0.9rem', color: 'rgba(255, 255, 255, 0.8)' }}>
                        The contract's payout mechanism is not working properly. 
                        {payoutAddress === '0x0000000000000000000000000000000000000000' 
                            ? ` The payout address is set to zero address (${payoutAddress}).` 
                            : ` Payout address: ${payoutAddress}`}
                        Minting is currently disabled until this issue is resolved.
                    </div>
                    
                    {/* Contract Diagnostics */}
                    {contractDiagnostics && (
                        <div style={{ 
                            marginTop: '1rem', 
                            padding: '0.8rem', 
                            background: 'rgba(0, 0, 0, 0.3)', 
                            borderRadius: '4px',
                            fontSize: '0.8rem'
                        }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>🔍 Diagnostics:</div>
                            <div>Payout Address Valid: {contractDiagnostics.payoutAddressValid ? '✅' : '❌'}</div>
                            <div>Sale Active: {contractDiagnostics.saleActive ? '✅' : '❌'}</div>
                            <div>Price Valid: {contractDiagnostics.priceValid ? '✅' : '❌'}</div>
                            <div>Gas Estimation Works: {contractDiagnostics.gasEstimationWorks ? '✅' : '❌'}</div>
                            <div>Contract Callable: {contractDiagnostics.contractCallable ? '✅' : '❌'}</div>
                            {contractDiagnostics.payoutAddressBalance && (
                                <div>Payout Address Balance: {contractDiagnostics.payoutAddressBalance} VTRU</div>
                            )}
                            
                            {contractDiagnostics.recommendations && contractDiagnostics.recommendations.length > 0 && (
                                <div style={{ marginTop: '0.5rem' }}>
                                    <div style={{ fontWeight: 'bold' }}>📝 Issues Found:</div>
                                    {contractDiagnostics.recommendations.map((rec, index) => (
                                        <div key={index} style={{ color: '#ffcc00', marginLeft: '1rem' }}>
                                            • {rec}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Debug Information (for development) */}
            {import.meta.env.VITE_DEBUG_MODE === 'true' && contractDiagnostics && (
                <div style={{
                    padding: '1rem',
                    marginBottom: '1.5rem',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#fff',
                    fontSize: '0.8rem'
                }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
                        🛠️ Debug Information
                    </div>
                    <div style={{ fontFamily: 'monospace' }}>
                        <div>Contract Address: {nftAddress}</div>
                        <div>Payout Address: {payoutAddress}</div>
                        <div>Mint Price: {mintPrice} VTRU</div>
                        <div>Sale Active: {saleActive ? 'true' : 'false'}</div>
                        <div>Total Supply: {totalSupply} / {maxSupply}</div>
                        <div>User Balance: {userBalance} NFTs</div>
                        <div>Wallet Connected: {wallet || 'None'}</div>
                        <div>Signer Available: {signer ? 'Yes' : 'No'}</div>
                        <div style={{ marginTop: '0.5rem' }}>
                            Diagnostics: {JSON.stringify(contractDiagnostics, null, 2)}
                        </div>
                    </div>
                </div>
            )}

            {/* Mint Section */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>Mint Information</h3>
                </div>
                
                <div className="hp-mini">
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Mint Price</div>
                        <div className="hp-mini__value">{formatVTRU(mintPrice)} VTRU</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Sale Status</div>
                        <div className="hp-mini__value" style={{ color: saleActive ? '#00ff88' : '#ff4444' }}>
                            {saleActive ? '🟢 Active' : '🔴 Inactive'}
                        </div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Total Supply</div>
                        <div className="hp-mini__value">{totalSupply.toLocaleString()} / {maxSupply.toLocaleString()}</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Progress</div>
                        <div className="hp-mini__value">{getProgressPercentage().toFixed(1)}%</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Your NFTs</div>
                        <div className="hp-mini__value">{userBalance}</div>
                    </div>
                    <div className="hp-mini__card">
                        <div className="hp-mini__label">Contract Status</div>
                        <div className="hp-mini__value" style={{ color: contractHealthy ? '#00ff88' : '#ff4444' }}>
                            {contractHealthy ? '✅ Healthy' : '⚠️ Issue'}
                        </div>
                    </div>
                </div>

                {/* Progress Bar */}
                <div style={{ marginTop: '1.5rem' }}>
                    <div style={{
                        width: '100%',
                        height: '12px',
                        background: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        marginBottom: '0.5rem'
                    }}>
                        <div style={{
                            width: `${getProgressPercentage()}%`,
                            height: '100%',
                            background: 'linear-gradient(90deg, #5533ff, #ff3366)',
                            borderRadius: '6px',
                            transition: 'width 0.3s ease'
                        }} />
                    </div>
                    <div style={{ 
                        textAlign: 'center', 
                        fontSize: '0.9rem', 
                        color: 'var(--hp-muted)' 
                    }}>
                        {totalSupply.toLocaleString()} of {maxSupply.toLocaleString()} minted
                    </div>
                </div>

                {/* Mint Button */}
                {wallet && saleActive && totalSupply < maxSupply && contractHealthy && (
                    <div style={{ marginTop: '2rem', textAlign: 'center' }}>
                        <button 
                            className="hp-btn hp-btn--primary"
                            onClick={handleMint}
                            disabled={minting || loading}
                            style={{ 
                                fontSize: '1.2rem', 
                                padding: '1rem 3rem',
                                background: 'linear-gradient(135deg, #5533ff, #ff3366)',
                                border: 'none',
                                position: 'relative',
                                overflow: 'hidden'
                            }}
                        >
                            {minting ? 'Minting...' : `Mint for ${formatVTRU(mintPrice)} VTRU`}
                        </button>
                    </div>
                )}

                {wallet && !contractHealthy && (
                    <div style={{ 
                        marginTop: '2rem', 
                        textAlign: 'center',
                        color: '#ff4444',
                        fontSize: '1.1rem',
                        fontWeight: 'bold'
                    }}>
                        ⚠️ Contract configuration issue - minting disabled
                    </div>
                )}

                {wallet && !saleActive && (
                    <div style={{ 
                        marginTop: '2rem', 
                        textAlign: 'center',
                        color: 'var(--hp-muted)',
                        fontSize: '1.1rem',
                        fontWeight: 'bold'
                    }}>
                        🚫 Minting is currently inactive
                    </div>
                )}

                {wallet && totalSupply >= maxSupply && (
                    <div style={{ 
                        marginTop: '2rem', 
                        textAlign: 'center',
                        color: 'var(--hp-muted)',
                        fontSize: '1.1rem',
                        fontWeight: 'bold'
                    }}>
                        🎉 All RevShare NFTs have been minted!
                    </div>
                )}
            </div>

            {/* Your NFTs Section */}
            {userTokens.length > 0 && (
                <div className="hp-section">
                    <div className="hp-section__head">
                        <h3>Your RevShare NFTs</h3>
                    </div>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                        gap: '1rem',
                        marginTop: '1rem'
                    }}>
                        {userTokens.map(tokenId => (
                            <div key={tokenId} style={{
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '8px',
                                padding: '1rem',
                                textAlign: 'center'
                            }}>
                                <div style={{ 
                                    fontSize: '2rem', 
                                    marginBottom: '0.5rem' 
                                }}>
                                    💎
                                </div>
                                <div style={{ 
                                    fontWeight: 'bold',
                                    color: 'var(--hp-accent)'
                                }}>
                                    #{tokenId}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* About RevShare NFTs */}
            <div className="hp-section">
                <div className="hp-section__head">
                    <h3>About RevShare NFTs</h3>
                </div>
                <div style={{ color: 'var(--hp-muted)', lineHeight: 1.6 }}>
                    <p>
                        <strong>Revenue Sharing:</strong> Each RevShare NFT grants you a share of BlockDust marketplace revenue.
                    </p>
                    <p>
                        <strong>Automatic Distribution:</strong> Revenue is automatically deposited to the treasury and distributed proportionally to NFT holders.
                    </p>
                    <p>
                        <strong>Claim Anytime:</strong> Visit the <a href="/blockshare" style={{ color: 'var(--hp-accent)' }}>BlockShare page</a> to view and claim your accumulated revenue.
                    </p>
                    <p>
                        <strong>Limited Supply:</strong> Only {maxSupply.toLocaleString()} RevShare NFTs will ever exist, making each one valuable.
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
                    Loading mint data...
                </div>
            )}
        </div>
    );
};

export default MintPage;