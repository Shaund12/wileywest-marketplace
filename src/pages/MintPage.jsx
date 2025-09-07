import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import RevShareNFTTreasuryAbi from '../abi/RevShareNFTTreasury.json';
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
    const [manualGasMode, setManualGasMode] = useState(false);
    const [manualGasLimit, setManualGasLimit] = useState('400000');

    // Use the new combined contract address, fall back to old NFT address if not set
    const nftAddress = import.meta.env.VITE_REVSHARE_NFT_TREASURY_ADDRESS || import.meta.env.VITE_REVSHARE_NFT_ADDRESS;

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
            debugLog('Initializing RevShare NFT Treasury contract...');
            const contract = new ethers.Contract(nftAddress, RevShareNFTTreasuryAbi.abi, provider);
            setNftContract(contract);
            debugLog('RevShare NFT Treasury contract initialized successfully');
        } catch (error) {
            criticalError('Failed to initialize RevShare NFT Treasury contract:', error);
            setStatus('Failed to connect to RevShare NFT Treasury contract');
        }
    };

    const loadContractData = async () => {
        if (!nftContract) return;
        
        try {
            setLoading(true);
            debugLog('Loading contract data...');
            
            const [price, total, max, active, payout] = await Promise.all([
                nftContract.mintPriceWei(),
                nftContract.totalSupply(),
                nftContract.maxSupply(),
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
            payoutAddressType: 'unknown',
            payoutCanReceiveETH: false,
            contractHasETH: false,
            recommendations: []
        };

        try {
            // Check payout address
            const isZeroAddress = payout === '0x0000000000000000000000000000000000000000';
            diagnostics.payoutAddressValid = !isZeroAddress;
            
            if (isZeroAddress) {
                diagnostics.recommendations.push('Contract payout address is set to zero address');
            }

            // Enhanced payout address analysis
            if (!isZeroAddress && provider) {
                try {
                    // Check balance
                    const balance = await provider.getBalance(payout);
                    diagnostics.payoutAddressBalance = ethers.formatEther(balance);
                    
                    // Check if it's a contract or EOA
                    const code = await provider.getCode(payout);
                    const isContract = code !== '0x';
                    diagnostics.payoutAddressType = isContract ? 'contract' : 'EOA';
                    
                    debugLog(`Payout address ${payout}:`);
                    debugLog(`- Type: ${diagnostics.payoutAddressType}`);
                    debugLog(`- Balance: ${diagnostics.payoutAddressBalance} VTRU`);
                    debugLog(`- Code length: ${code.length > 2 ? (code.length - 2) / 2 : 0} bytes`);
                    
                    // Test if payout address can receive ETH by simulating a transfer
                    if (signer) {
                        try {
                            const userAddress = await signer.getAddress();
                            const userBalance = await provider.getBalance(userAddress);
                            
                            // Only test if user has some ETH
                            if (userBalance > ethers.parseEther('0.001')) {
                                // Simulate sending 1 wei to the payout address
                                const simulationTx = {
                                    to: payout,
                                    value: '0x1', // 1 wei
                                    from: userAddress
                                };
                                
                                // Use call to simulate without actually sending
                                await provider.call(simulationTx);
                                diagnostics.payoutCanReceiveETH = true;
                                debugLog('✅ Payout address can receive ETH');
                            } else {
                                diagnostics.recommendations.push('Cannot test ETH transfer - insufficient user balance');
                            }
                        } catch (simulationError) {
                            diagnostics.payoutCanReceiveETH = false;
                            debugWarn('❌ Payout address cannot receive ETH:', simulationError);
                            
                            if (isContract) {
                                diagnostics.recommendations.push('Payout address is a contract that cannot receive ETH (no receive/fallback function or they revert)');
                            } else {
                                diagnostics.recommendations.push(`Payout address cannot receive ETH: ${simulationError.message}`);
                            }
                        }
                    }
                } catch (error) {
                    debugWarn('Could not analyze payout address:', error);
                    diagnostics.recommendations.push(`Cannot analyze payout address: ${error.message}`);
                }
            }

            // Check if the NFT contract itself has ETH (needed for gas when sending to payout)
            if (nftAddress && provider) {
                try {
                    const contractBalance = await provider.getBalance(nftAddress);
                    diagnostics.contractHasETH = contractBalance > 0;
                    debugLog(`NFT contract balance: ${ethers.formatEther(contractBalance)} VTRU`);
                } catch (error) {
                    debugWarn('Could not check NFT contract balance:', error);
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
                    
                    debugLog('Testing gas estimation with:');
                    debugLog(`- Mint price: ${ethers.formatEther(mintPriceWei)} VTRU`);
                    debugLog(`- Payout address: ${payout}`);
                    debugLog(`- Payout type: ${diagnostics.payoutAddressType}`);
                    debugLog(`- Can receive ETH: ${diagnostics.payoutCanReceiveETH}`);
                    
                    // Enhanced gas estimation with multiple strategies
                    let gasEstimate = null;
                    let estimationMethod = 'unknown';
                    
                    // Strategy 1: Standard gas estimation
                    try {
                        gasEstimate = await contractWithSigner.mint.estimateGas(1, { value: mintPriceWei });
                        estimationMethod = 'standard';
                        debugLog(`✅ Standard gas estimation successful: ${gasEstimate.toString()} gas`);
                    } catch (standardError) {
                        debugWarn('Standard gas estimation failed:', standardError);
                        
                        // Strategy 2: Try with higher gas limit
                        try {
                            gasEstimate = await contractWithSigner.mint.estimateGas(1, { 
                                value: mintPriceWei,
                                gasLimit: 500000 // Fixed high gas limit
                            });
                            estimationMethod = 'high-gas-limit';
                            debugLog(`✅ High gas limit estimation successful: ${gasEstimate.toString()} gas`);
                        } catch (highGasError) {
                            debugWarn('High gas limit estimation failed:', highGasError);
                            
                            // Strategy 3: Try static gas analysis
                            try {
                                // Use a conservative fixed gas estimate based on typical mint operations
                                if (diagnostics.payoutAddressType === 'contract') {
                                    gasEstimate = 300000n; // Higher for contract payouts
                                } else {
                                    gasEstimate = 150000n; // Lower for EOA payouts
                                }
                                estimationMethod = 'static-analysis';
                                debugLog(`⚠️ Using static gas estimate: ${gasEstimate.toString()} gas (${estimationMethod})`);
                                
                                // Test if this static estimate would work by calling with gasLimit
                                await contractWithSigner.mint.estimateGas(1, { 
                                    value: mintPriceWei,
                                    gasLimit: gasEstimate
                                });
                                debugLog('✅ Static gas estimate validated');
                            } catch (staticError) {
                                debugWarn('Static gas estimation validation failed:', staticError);
                                throw standardError; // Throw the original error
                            }
                        }
                    }
                    
                    if (gasEstimate) {
                        diagnostics.gasEstimationWorks = true;
                        diagnostics.gasEstimate = gasEstimate.toString();
                        diagnostics.gasEstimationMethod = estimationMethod;
                        debugLog(`✅ Gas estimation successful via ${estimationMethod}: ${gasEstimate.toString()} gas`);
                    } else {
                        throw new Error('All gas estimation strategies failed');
                    }
                    
                } catch (error) {
                    diagnostics.gasEstimationWorks = false;
                    debugWarn('❌ All gas estimation strategies failed:', error);
                    
                    // Enhanced error analysis
                    const errorMessage = error.message || '';
                    const errorData = error.data || '';
                    const errorCode = error.code || '';
                    
                    debugLog('Error analysis:', {
                        message: errorMessage,
                        data: errorData,
                        code: errorCode,
                        reason: error.reason
                    });
                    
                    if (errorMessage.includes('payout fail')) {
                        if (diagnostics.payoutAddressType === 'contract' && !diagnostics.payoutCanReceiveETH) {
                            diagnostics.recommendations.push('IDENTIFIED: Payout address is a contract that cannot receive ETH. The contract needs a receive() or fallback() function, or the payout address should be changed to an EOA.');
                        } else if (diagnostics.payoutAddressType === 'contract') {
                            diagnostics.recommendations.push('IDENTIFIED: Payout address is a contract. The mint transaction requires significantly more gas to complete the payout transfer to a contract.');
                            diagnostics.recommendations.push('SOLUTION: Try minting with manual gas limit of 500,000+ or ask the contract owner to change payout to an EOA.');
                        } else {
                            diagnostics.recommendations.push('IDENTIFIED: Payout mechanism is failing. This may be a contract bug, insufficient contract balance, or gas limit issue.');
                        }
                    } else if (errorMessage.includes('missing revert data')) {
                        diagnostics.recommendations.push('IDENTIFIED: Contract is reverting without clear error data. This often indicates:');
                        diagnostics.recommendations.push('• Gas limit too low for complex payout operations');
                        diagnostics.recommendations.push('• Contract state issue preventing successful execution');
                        diagnostics.recommendations.push('• Payout address cannot properly receive the transfer');
                        diagnostics.recommendations.push('SOLUTION: Try manual gas limit of 500,000+ or contact contract administrator');
                    } else if (errorMessage.includes('insufficient funds')) {
                        // This is actually good - it means gas estimation worked but user doesn't have enough ETH
                        diagnostics.gasEstimationWorks = true;
                        diagnostics.recommendations.push('Gas estimation works, but you need more VTRU for minting');
                    } else if (errorMessage.includes('execution reverted')) {
                        diagnostics.recommendations.push(`Contract execution reverted: ${error.reason || errorMessage}`);
                    } else {
                        diagnostics.recommendations.push(`Gas estimation failed: ${errorMessage}`);
                        if (errorCode) {
                            diagnostics.recommendations.push(`Error code: ${errorCode}`);
                        }
                    }
                }
            }

            // Advanced recommendations based on findings
            if (!diagnostics.gasEstimationWorks && diagnostics.payoutAddressValid) {
                if (diagnostics.payoutAddressType === 'contract' && !diagnostics.payoutCanReceiveETH) {
                    diagnostics.recommendations.push('SOLUTION: Change the payout address to an EOA (externally owned account) or fix the contract to accept ETH transfers');
                } else if (diagnostics.payoutAddressType === 'contract') {
                    diagnostics.recommendations.push('SOLUTION: Consider increasing gas limit for the mint transaction or changing payout to an EOA');
                } else {
                    diagnostics.recommendations.push('SOLUTION: Contact the contract administrator to investigate the payout mechanism');
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
            } else {
                debugLog('✅ All contract health checks passed');
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
            
            // Enhanced gas estimation for the mint function
            setStatus('Estimating gas for mint transaction...');
            let gasEstimate;
            let gasEstimationMethod = 'unknown';
            
            // Check if user wants to use manual gas mode
            if (manualGasMode && manualGasLimit) {
                gasEstimate = BigInt(manualGasLimit);
                gasEstimationMethod = 'manual-override';
                debugLog(`Using manual gas limit: ${gasEstimate.toString()}`);
                setStatus('Using manual gas limit...');
            } else {
                try {
                    // Strategy 1: Use diagnostics gas estimate if available
                    if (contractDiagnostics?.gasEstimate && contractDiagnostics?.gasEstimationWorks) {
                        gasEstimate = BigInt(contractDiagnostics.gasEstimate);
                        gasEstimationMethod = contractDiagnostics.gasEstimationMethod;
                        debugLog(`Using pre-calculated gas estimate: ${gasEstimate.toString()} (${gasEstimationMethod})`);
                    } else {
                        // Strategy 2: Real-time gas estimation with fallbacks
                        try {
                            gasEstimate = await contractWithSigner.mint.estimateGas(1, { value: mintPriceWei });
                            gasEstimationMethod = 'realtime-standard';
                            debugLog('Real-time gas estimation successful:', gasEstimate.toString());
                        } catch (standardError) {
                            debugWarn('Standard gas estimation failed, trying alternatives...', standardError);
                            
                            try {
                                // Try with higher fixed gas limit
                                gasEstimate = await contractWithSigner.mint.estimateGas(1, { 
                                    value: mintPriceWei,
                                    gasLimit: 500000
                                });
                                gasEstimationMethod = 'realtime-high-gas';
                                debugLog('High gas limit estimation successful:', gasEstimate.toString());
                            } catch (highGasError) {
                                debugWarn('High gas estimation failed, using emergency fallback...', highGasError);
                                
                                // Emergency fallback: Use conservative static estimates
                                if (contractDiagnostics?.payoutAddressType === 'contract') {
                                    gasEstimate = 400000n; // Very high for problematic contract payouts
                                    gasEstimationMethod = 'emergency-contract-fallback';
                                } else {
                                    gasEstimate = 200000n; // High but reasonable for EOA payouts
                                    gasEstimationMethod = 'emergency-eoa-fallback';
                                }
                                
                                debugLog(`Using emergency gas estimate: ${gasEstimate.toString()} (${gasEstimationMethod})`);
                                
                                // Test if this emergency estimate is reasonable by trying a validation call
                                try {
                                    await contractWithSigner.mint.staticCall(1, { 
                                        value: mintPriceWei,
                                        gasLimit: gasEstimate
                                    });
                                    debugLog('✅ Emergency gas estimate validated with staticCall');
                                } catch (staticError) {
                                    debugWarn('Emergency gas estimate validation failed:', staticError);
                                    
                                    // Suggest manual gas mode
                                    setStatus('❌ Automatic gas estimation failed. Please try Manual Gas Mode below.');
                                    setManualGasMode(true);
                                    return;
                                }
                            }
                        }
                    }
                } catch (gasError) {
                    criticalError('All gas estimation strategies failed:', gasError);
                    
                    // Enhanced error handling with more specific messages
                    const errorMsg = gasError.message || '';
                    
                    if (errorMsg.includes('payout fail')) {
                        setStatus('❌ Contract Error: The minting payout mechanism is failing. Please try Manual Gas Mode below or contact the contract administrator.');
                        setManualGasMode(true);
                        return;
                    } else if (errorMsg.includes('missing revert data')) {
                        setStatus('❌ Contract Error: Transaction is failing without clear error data. Please try Manual Gas Mode below.');
                        setManualGasMode(true);
                        return;
                    } else if (errorMsg.includes('sale not active')) {
                        setStatus('Minting is not currently active');
                        return;
                    } else if (errorMsg.includes('max supply reached')) {
                        setStatus('All RevShare NFTs have been minted');
                        return;
                    } else if (errorMsg.includes('insufficient payment')) {
                        setStatus('Insufficient payment amount. Please check the mint price.');
                        return;
                    } else if (errorMsg.includes('insufficient funds')) {
                        setStatus('Insufficient VTRU balance to mint. You need more VTRU in your wallet.');
                        return;
                    } else {
                        setStatus(`❌ Gas estimation failed: ${gasError.reason || errorMsg}. Please try Manual Gas Mode below.`);
                        setManualGasMode(true);
                        return;
                    }
                }
            }
            
            // Calculate gas limit with appropriate buffer based on estimation method
            let gasBuffer = 20; // Default 20% buffer
            if (gasEstimationMethod.includes('emergency') || gasEstimationMethod.includes('static') || gasEstimationMethod.includes('manual')) {
                gasBuffer = 10; // Lower buffer for already conservative estimates
            } else if (gasEstimationMethod.includes('high-gas')) {
                gasBuffer = 15; // Medium buffer for high gas estimates
            }
            
            const gasLimit = gasEstimate * BigInt(100 + gasBuffer) / 100n;
            
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
                            {contractDiagnostics.payoutAddressType && (
                                <div>Payout Address Type: {contractDiagnostics.payoutAddressType}</div>
                            )}
                            {contractDiagnostics.payoutCanReceiveETH !== undefined && (
                                <div>Payout Can Receive ETH: {contractDiagnostics.payoutCanReceiveETH ? '✅' : '❌'}</div>
                            )}
                            {contractDiagnostics.gasEstimate && (
                                <div>Estimated Gas: {parseInt(contractDiagnostics.gasEstimate).toLocaleString()}</div>
                            )}
                            {contractDiagnostics.gasEstimationMethod && (
                                <div>Gas Method: {contractDiagnostics.gasEstimationMethod}</div>
                            )}
                            
                            {contractDiagnostics.recommendations && contractDiagnostics.recommendations.length > 0 && (
                                <div style={{ marginTop: '0.5rem' }}>
                                    <div style={{ fontWeight: 'bold' }}>📝 Analysis:</div>
                                    {contractDiagnostics.recommendations.map((rec, index) => (
                                        <div key={index} style={{ 
                                            color: rec.startsWith('IDENTIFIED:') ? '#ff6b6b' : 
                                                   rec.startsWith('SOLUTION:') ? '#4ecdc4' : 
                                                   rec.startsWith('•') ? '#ffcc00' :
                                                   '#ffcc00', 
                                            marginLeft: '1rem',
                                            fontWeight: rec.startsWith('IDENTIFIED:') || rec.startsWith('SOLUTION:') ? 'bold' : 'normal'
                                        }}>
                                            {rec.startsWith('•') ? rec : `• ${rec}`}
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
                        <div>Payout Address Type: {contractDiagnostics?.payoutAddressType || 'Unknown'}</div>
                        <div>Payout Can Receive ETH: {contractDiagnostics?.payoutCanReceiveETH ? 'Yes' : 'No'}</div>
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

                {/* Manual Gas Mode */}
                {wallet && saleActive && totalSupply < maxSupply && (
                    <div style={{ marginTop: '1.5rem' }}>
                        <div style={{
                            padding: '1rem',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px'
                        }}>
                            <div style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                marginBottom: '0.5rem',
                                cursor: 'pointer'
                            }} onClick={() => setManualGasMode(!manualGasMode)}>
                                <input 
                                    type="checkbox" 
                                    checked={manualGasMode}
                                    onChange={(e) => setManualGasMode(e.target.checked)}
                                    style={{ marginRight: '0.5rem' }}
                                />
                                <label style={{ fontWeight: 'bold', color: '#ffcc00' }}>
                                    🛠️ Manual Gas Mode (Advanced)
                                </label>
                            </div>
                            
                            {manualGasMode && (
                                <div style={{ marginTop: '1rem' }}>
                                    <div style={{ 
                                        fontSize: '0.9rem', 
                                        color: 'rgba(255, 255, 255, 0.7)',
                                        marginBottom: '0.5rem'
                                    }}>
                                        Use this when automatic gas estimation fails. Higher gas limits work better for contract payout addresses.
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                        <label style={{ minWidth: '80px', fontSize: '0.9rem' }}>Gas Limit:</label>
                                        <input
                                            type="number"
                                            value={manualGasLimit}
                                            onChange={(e) => setManualGasLimit(e.target.value)}
                                            min="100000"
                                            max="1000000"
                                            step="10000"
                                            style={{
                                                flex: 1,
                                                padding: '0.5rem',
                                                borderRadius: '4px',
                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                background: 'rgba(0, 0, 0, 0.5)',
                                                color: '#fff'
                                            }}
                                        />
                                    </div>
                                    <div style={{ 
                                        display: 'flex', 
                                        gap: '0.5rem', 
                                        fontSize: '0.8rem',
                                        marginTop: '0.5rem'
                                    }}>
                                        <button 
                                            onClick={() => setManualGasLimit('200000')}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                borderRadius: '4px',
                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                background: 'rgba(255, 255, 255, 0.1)',
                                                color: '#fff',
                                                fontSize: '0.8rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            Low (200k)
                                        </button>
                                        <button 
                                            onClick={() => setManualGasLimit('400000')}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                borderRadius: '4px',
                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                background: 'rgba(255, 255, 255, 0.1)',
                                                color: '#fff',
                                                fontSize: '0.8rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            Medium (400k)
                                        </button>
                                        <button 
                                            onClick={() => setManualGasLimit('600000')}
                                            style={{
                                                padding: '0.25rem 0.5rem',
                                                borderRadius: '4px',
                                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                                background: 'rgba(255, 255, 255, 0.1)',
                                                color: '#fff',
                                                fontSize: '0.8rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            High (600k)
                                        </button>
                                    </div>
                                    <div style={{ 
                                        fontSize: '0.8rem', 
                                        color: 'rgba(255, 255, 255, 0.6)',
                                        marginTop: '0.5rem'
                                    }}>
                                        💡 Recommended: Use "High (600k)" for contract payout addresses that are failing.
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {wallet && !contractHealthy && saleActive && totalSupply < maxSupply && (
                    <div style={{ 
                        marginTop: '2rem', 
                        textAlign: 'center'
                    }}>
                        <div style={{
                            marginBottom: '1rem',
                            color: '#ffcc00',
                            fontSize: '0.9rem'
                        }}>
                            ⚠️ Contract health check failed, but you can try Manual Gas Mode
                        </div>
                        <button 
                            className="hp-btn hp-btn--primary"
                            onClick={() => {
                                setManualGasMode(true);
                                setManualGasLimit('600000'); // Set high gas limit by default
                                handleMint();
                            }}
                            disabled={minting || loading}
                            style={{ 
                                fontSize: '1rem', 
                                padding: '0.8rem 2rem',
                                background: 'linear-gradient(135deg, #ff8800, #ff3366)',
                                border: 'none',
                                opacity: 0.9
                            }}
                        >
                            {minting ? 'Minting...' : `Try Mint with High Gas (${formatVTRU(mintPrice)} VTRU)`}
                        </button>
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