import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { getSupportedTokens, getTokenInfo } from '../utils/tokenRegistry';
import { ethers } from 'ethers';

function AdminPathsPage() {
    const navigate = useNavigate();
    const { wallet, connect, provider } = useWallet();
    const { marketplace, status } = useMarketplace();
    const [paths, setPaths] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newPath, setNewPath] = useState({
        token: '',
        path: [],
        encoded: ''
    });
    const [pathBuilder, setPathBuilder] = useState([]);

    useEffect(() => {
        if (!wallet) {
            navigate('/?connect=true');
            return;
        }

        loadExistingPaths();
    }, [wallet, navigate, marketplace]);

    const loadExistingPaths = async () => {
        try {
            setLoading(true);
            if (!marketplace) return;

            const supportedTokens = getSupportedTokens();
            const pathPromises = supportedTokens.map(async (token) => {
                try {
                    const path = await marketplace.pathToWVTRU(token.address);
                    return {
                        token: token.address,
                        tokenInfo: token,
                        path,
                        hasPath: path && path !== '0x'
                    };
                } catch (error) {
                    return {
                        token: token.address,
                        tokenInfo: token,
                        path: '0x',
                        hasPath: false
                    };
                }
            });

            const results = await Promise.all(pathPromises);
            setPaths(results);
        } catch (error) {
            console.error('Error loading paths:', error);
        } finally {
            setLoading(false);
        }
    };

    const addPathStep = () => {
        setPathBuilder([...pathBuilder, { token: '', fee: '3000' }]);
    };

    const removePathStep = (index) => {
        setPathBuilder(pathBuilder.filter((_, i) => i !== index));
    };

    const updatePathStep = (index, field, value) => {
        const updated = [...pathBuilder];
        updated[index][field] = value;
        setPathBuilder(updated);
        encodePathFromBuilder(updated);
    };

    const encodePathFromBuilder = (steps) => {
        if (steps.length === 0) {
            setNewPath(prev => ({ ...prev, encoded: '' }));
            return;
        }

        try {
            // Encode Uniswap V3 path: token0 + fee + token1 + fee + ... + tokenN
            let encoded = '0x';
            
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                if (!step.token) continue;
                
                // Add token address (20 bytes)
                encoded += step.token.slice(2);
                
                // Add fee (3 bytes) if not the last step
                if (i < steps.length - 1) {
                    const feeHex = parseInt(step.fee).toString(16).padStart(6, '0');
                    encoded += feeHex;
                }
            }

            setNewPath(prev => ({ ...prev, encoded }));
        } catch (error) {
            console.error('Error encoding path:', error);
            setNewPath(prev => ({ ...prev, encoded: '' }));
        }
    };

    const handleSetPath = async () => {
        if (!newPath.token || !newPath.encoded) {
            alert('Please select a token and build a valid path');
            return;
        }

        try {
            const tx = await marketplace.setPathToWVTRU(newPath.token, newPath.encoded);
            await tx.wait();
            
            // Reload paths
            await loadExistingPaths();
            
            // Reset form
            setNewPath({ token: '', path: [], encoded: '' });
            setPathBuilder([]);
        } catch (error) {
            console.error('Error setting path:', error);
            alert('Failed to set path: ' + error.message);
        }
    };

    const formatPath = (pathBytes) => {
        if (!pathBytes || pathBytes === '0x') return 'No path set';
        
        try {
            // Decode the path to show token symbols
            // This is a simplified display - in practice you'd fully decode the path
            return `Path length: ${(pathBytes.length - 2) / 2} bytes`;
        } catch (error) {
            return 'Invalid path';
        }
    };

    if (!wallet) {
        return (
            <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Admin: Uniswap V3 Paths</h2>
                    <p>Connect your wallet to manage token swap paths</p>
                </div>
                <button onClick={connect} className="hp-btn hp-btn--primary">
                    Connect Wallet
                </button>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1000, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>Admin: Uniswap V3 Paths</h2>
                <p>Configure token → wVTRU swap paths for fee conversion</p>
            </div>

            {/* Existing Paths */}
            <section className="existing-paths">
                <h3>Current Paths</h3>
                {loading ? (
                    <p>Loading existing paths...</p>
                ) : (
                    <div className="paths-table">
                        <div className="table-header">
                            <span>Token</span>
                            <span>Path</span>
                            <span>Status</span>
                        </div>
                        {paths.map((pathInfo, index) => (
                            <div key={index} className="table-row">
                                <span className="token-info">
                                    <strong>{pathInfo.tokenInfo.symbol}</strong>
                                    <small>{pathInfo.tokenInfo.name}</small>
                                </span>
                                <span className="path-info">
                                    {formatPath(pathInfo.path)}
                                </span>
                                <span className={`status ${pathInfo.hasPath ? 'active' : 'inactive'}`}>
                                    {pathInfo.hasPath ? '✅ Set' : '❌ Not Set'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Path Builder */}
            <section className="path-builder">
                <h3>Create New Path</h3>
                
                <div className="form-group">
                    <label>Select Token</label>
                    <select 
                        value={newPath.token} 
                        onChange={(e) => setNewPath(prev => ({ ...prev, token: e.target.value }))}
                    >
                        <option value="">Select a token...</option>
                        {getSupportedTokens()
                            .filter(token => !token.isNative && token.symbol !== 'wVTRU')
                            .map(token => (
                                <option key={token.address} value={token.address}>
                                    {token.symbol} - {token.name}
                                </option>
                            ))
                        }
                    </select>
                </div>

                <div className="path-steps">
                    <h4>Build Swap Path</h4>
                    <p>Create the path: Token → [intermediate tokens] → wVTRU</p>
                    
                    {pathBuilder.map((step, index) => (
                        <div key={index} className="path-step">
                            <div className="step-number">{index + 1}</div>
                            <select 
                                value={step.token}
                                onChange={(e) => updatePathStep(index, 'token', e.target.value)}
                            >
                                <option value="">Select token...</option>
                                {getSupportedTokens().map(token => (
                                    <option key={token.address} value={token.address}>
                                        {token.symbol}
                                    </option>
                                ))}
                            </select>
                            <select 
                                value={step.fee}
                                onChange={(e) => updatePathStep(index, 'fee', e.target.value)}
                            >
                                <option value="500">0.05% fee</option>
                                <option value="3000">0.3% fee</option>
                                <option value="10000">1% fee</option>
                            </select>
                            <button 
                                onClick={() => removePathStep(index)}
                                className="hp-btn hp-btn--danger"
                            >
                                Remove
                            </button>
                        </div>
                    ))}
                    
                    <button onClick={addPathStep} className="hp-btn">
                        Add Path Step
                    </button>
                </div>

                {newPath.encoded && (
                    <div className="encoded-path">
                        <h4>Encoded Path</h4>
                        <code>{newPath.encoded}</code>
                    </div>
                )}

                <div className="form-actions">
                    <button 
                        onClick={handleSetPath}
                        className="hp-btn hp-btn--primary"
                        disabled={!newPath.token || !newPath.encoded}
                    >
                        Set Path
                    </button>
                    <button 
                        onClick={() => {
                            setNewPath({ token: '', path: [], encoded: '' });
                            setPathBuilder([]);
                        }}
                        className="hp-btn"
                    >
                        Clear
                    </button>
                </div>
            </section>

            {status && (
                <div className="status-message">
                    {status}
                </div>
            )}
        </div>
    );
}

export default AdminPathsPage;