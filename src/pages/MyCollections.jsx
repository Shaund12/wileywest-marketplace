import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { ethers } from 'ethers';
import supabaseService from '../lib/supabaseClient';

// SIWE (Sign-In with Ethereum) helper
const generateSiweMessage = (address, chainId, nonce) => {
  const domain = window.location.host;
  const uri = window.location.origin;
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
  
  return `${domain} wants you to sign in with your Ethereum account:
${address}

I accept the WileyWest Terms of Service: ${uri}/terms

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
};

const generateNonce = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

function MyCollections() {
  const navigate = useNavigate();
  const { wallet, signer, chainId } = useWallet();
  const [profileId, setProfileId] = useState(null);
  const [nftHoldings, setNftHoldings] = useState([]);
  const [collections, setCollections] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnsuring, setIsEnsuring] = useState(false);
  const [status, setStatus] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('count');
  const [viewMode, setViewMode] = useState('grid');
  const [expandedCollections, setExpandedCollections] = useState(new Set());
  
  const subscriptionRef = useRef(null);

  // Cleanup subscription on unmount
  useEffect(() => {
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
    };
  }, []);

  // Process NFT holdings into collection groups
  const processNFTHoldings = useCallback((holdings) => {
    const collectionMap = new Map();
    
    holdings.forEach(holding => {
      const key = holding.contract_address.toLowerCase();
      
      if (!collectionMap.has(key)) {
        collectionMap.set(key, {
          contract_address: holding.contract_address,
          collection_name: holding.collection_name || `Collection ${holding.contract_address.slice(0, 6)}...`,
          collection_symbol: holding.collection_symbol || '',
          token_standard: holding.token_standard,
          tokens: [],
          token_count: 0,
          total_balance: 0
        });
      }
      
      const collection = collectionMap.get(key);
      collection.tokens.push(holding);
      collection.token_count++;
      collection.total_balance += parseInt(holding.balance);
    });
    
    let collectionsArray = Array.from(collectionMap.values());
    
    // Apply filter
    if (filter) {
      const filterLower = filter.toLowerCase();
      collectionsArray = collectionsArray.filter(collection => 
        collection.collection_name?.toLowerCase().includes(filterLower) ||
        collection.collection_symbol?.toLowerCase().includes(filterLower) ||
        collection.contract_address.toLowerCase().includes(filterLower) ||
        collection.tokens.some(token => 
          token.name?.toLowerCase().includes(filterLower) ||
          token.token_id.includes(filter)
        )
      );
    }
    
    // Apply sorting
    collectionsArray.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return (a.collection_name || '').localeCompare(b.collection_name || '');
        case 'updated':
          const aUpdated = Math.max(...a.tokens.map(t => new Date(t.updated_at).getTime()));
          const bUpdated = Math.max(...b.tokens.map(t => new Date(t.updated_at).getTime()));
          return bUpdated - aUpdated;
        case 'count':
        default:
          return b.token_count - a.token_count;
      }
    });
    
    setCollections(collectionsArray);
  }, [filter, sortBy]);

  // Load NFT holdings from cache
  const loadNFTHoldings = useCallback(async () => {
    if (!wallet || !supabaseService.isConnected) return;
    
    setIsLoading(true);
    setStatus('Loading your NFT collection...');
    
    try {
      const holdings = await supabaseService.getNFTHoldings(wallet, chainId || 1490);
      setNftHoldings(holdings);
      processNFTHoldings(holdings);
      
      if (holdings.length > 0) {
        const newest = holdings.reduce((latest, holding) => 
          new Date(holding.updated_at) > new Date(latest.updated_at) ? holding : latest
        );
        setLastUpdated(new Date(newest.updated_at));
        setStatus(`✅ Loaded ${holdings.length} NFTs from ${new Set(holdings.map(h => h.contract_address)).size} collections`);
      } else {
        setStatus('📭 No NFTs found - try "Setup Profile" to scan your wallet');
      }
    } catch (error) {
      console.error('Error loading NFT holdings:', error);
      if (error.message?.includes('relation') || error.message?.includes('does not exist')) {
        setStatus('⚠️ Database not configured - NFT tracking unavailable');
      } else {
        setStatus('❌ Error loading NFT collection');
      }
    } finally {
      setIsLoading(false);
      setTimeout(() => setStatus(''), 5000);
    }
  }, [wallet, chainId, processNFTHoldings]);

  // Ensure profile exists (SIWE + profile creation with fallback)
  const ensureProfile = useCallback(async () => {
    if (!wallet || !signer || !chainId || !supabaseService.isConnected) return;
    
    setIsEnsuring(true);
    setStatus('Setting up your profile...');
    
    try {
      // Try with SIWE first if we have a signer
      let result = null;
      
      try {
        // Generate SIWE message and get signature
        const nonce = generateNonce();
        const message = generateSiweMessage(wallet, chainId, nonce);
        
        setStatus('Please sign the message to verify wallet ownership...');
        const signature = await signer.signMessage(message);
        
        setStatus('Creating profile...');
        
        // Call ensure_profile Edge Function
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ensure_profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
          },
          body: JSON.stringify({
            wallet,
            chainId,
            message,
            signature
          })
        });
        
        if (response.ok) {
          result = await response.json();
        } else {
          throw new Error('Edge Function not available');
        }
      } catch (edgeFunctionError) {
        console.warn('Edge Functions not available, using fallback:', edgeFunctionError.message);
        setStatus('Creating profile (fallback mode)...');
        
        // Use fallback method
        result = await supabaseService.ensureProfileFallback(wallet, chainId);
      }
      
      if (result) {
        setProfileId(result.profileId);
        
        if (result.usingFallback) {
          setStatus('✅ Profile created (offline mode) - background sync not available');
        } else if (result.syncQueued) {
          setStatus('✅ Profile created and sync queued - your NFTs will be updated shortly');
        } else {
          setStatus('✅ Profile created - manually triggering refresh...');
          // If sync wasn't queued, try to request it manually
          await supabaseService.requestSync(wallet, chainId, 1);
        }
      } else {
        setStatus('✅ Profile ready - some features may be limited without backend services');
      }
      
      // Load current holdings (may be empty if no backend)
      await loadNFTHoldings();
      
    } catch (error) {
      console.error('Error ensuring profile:', error);
      setStatus(`❌ Profile setup failed: ${error.message}`);
    } finally {
      setIsEnsuring(false);
      setTimeout(() => setStatus(''), 8000);
    }
  }, [wallet, signer, chainId, loadNFTHoldings]);

  // Request sync refresh
  const requestRefresh = useCallback(async () => {
    if (!wallet || !supabaseService.isConnected) return;
    
    setStatus('⏳ Refresh requested - your NFTs will update in 2-5 minutes...');
    
    try {
      const success = await supabaseService.requestSync(wallet, chainId || 1490, 3);
      if (success) {
        setStatus('✅ Refresh queued - check back in a few minutes');
      } else {
        setStatus('❌ Failed to queue refresh');
      }
    } catch (error) {
      console.error('Error requesting refresh:', error);
      setStatus('❌ Error requesting refresh');
    }
    
    setTimeout(() => setStatus(''), 5000);
  }, [wallet, chainId]);

  // Set up real-time subscription for wallet changes
  useEffect(() => {
    if (!wallet || !supabaseService.isConnected) return;
    
    // Clean up existing subscription
    if (subscriptionRef.current) {
      subscriptionRef.current.unsubscribe();
    }
    
    // Set up new subscription
    subscriptionRef.current = supabaseService.subscribeToNFTChanges(wallet, (payload) => {
      console.log('NFT holdings changed:', payload);
      // Reload holdings when they change
      loadNFTHoldings();
    });
    
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
    };
  }, [wallet, loadNFTHoldings]);

  // Initial load
  useEffect(() => {
    if (!wallet || !supabaseService.isConnected) return;
    
    const initializeProfile = async () => {
      // Check if profile exists
      const profile = await supabaseService.getWalletProfile(wallet);
      
      if (profile) {
        setProfileId(profile.profile_id || null);
        await loadNFTHoldings();
        
        // Check if data is stale (> 10 minutes) and needs refresh
        if (profile.last_synced_at) {
          const lastSync = new Date(profile.last_synced_at);
          const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
          
          if (lastSync < tenMinutesAgo && !profile.needs_sync) {
            console.log('Data is stale, requesting background refresh');
            supabaseService.requestSync(wallet, chainId || 1490, 5); // Low priority
          }
        }
      } else {
        // No profile exists, need to create one
        setStatus('💡 Click "Setup Profile" to enable NFT collection tracking');
      }
    };
    
    initializeProfile();
  }, [wallet, chainId, loadNFTHoldings]);

  // Toggle collection expansion
  const toggleCollection = (contractAddress) => {
    const newExpanded = new Set(expandedCollections);
    if (newExpanded.has(contractAddress)) {
      newExpanded.delete(contractAddress);
    } else {
      newExpanded.add(contractAddress);
    }
    setExpandedCollections(newExpanded);
  };

  // Generate fallback image for NFTs without images
  const generateFallbackImage = (contractAddress, tokenId) => {
    const hash = contractAddress.toLowerCase() + tokenId;
    let hashNum = 0;
    for (let i = 0; i < hash.length; i++) {
      hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
      hashNum = hashNum & hashNum;
    }
    
    const hue = Math.abs(hashNum % 360);
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='hsl(${hue},20%,10%)'/%3E%3Ccircle cx='150' cy='150' r='80' fill='none' stroke='hsl(${hue},60%,50%)' stroke-width='2'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='20' fill='hsl(${hue},60%,70%)' text-anchor='middle'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='12' fill='white' text-anchor='middle' opacity='0.7'%3ENFT%3C/text%3E%3C/svg%3E`;
  };

  if (!wallet) {
    return (
      <div className="profile-container">
        <div className="profile-not-connected">
          <h2>Connect your wallet to view your collections</h2>
          <p>Sign in with your Web3 wallet to see your NFT portfolio</p>
          <button className="primary-button" onClick={() => navigate('/')}>
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  if (!supabaseService.isConnected) {
    return (
      <div className="profile-container">
        <div className="profile-not-connected">
          <h2>NFT Collections</h2>
          <p>📭 NFT collection tracking is not configured.</p>
          <p>This feature requires backend services to scan and cache your wallet's NFTs.</p>
          <div className="wallet-display" style={{ marginTop: '20px' }}>
            <span className="label">Connected Wallet:</span>
            <span className="value">{wallet ? `${wallet.slice(0, 8)}...${wallet.slice(-6)}` : 'None'}</span>
          </div>
          <button className="secondary-button" onClick={() => navigate('/marketplace')} style={{ marginTop: '20px' }}>
            Browse Marketplace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-container">
      {/* Header */}
      <div className="profile-header">
        <div className="profile-info">
          <h1>My Collections</h1>
          <div className="wallet-display">
            <span className="label">Wallet:</span>
            <span className="value">{`${wallet.slice(0, 8)}...${wallet.slice(-6)}`}</span>
          </div>
        </div>
        
        <div className="profile-stats">
          <div className="stats-card">
            <div className="stats-value">{nftHoldings.length}</div>
            <div className="stats-label">Total NFTs</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{collections.length}</div>
            <div className="stats-label">Collections</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{lastUpdated ? lastUpdated.toLocaleDateString() : 'Never'}</div>
            <div className="stats-label">Last Updated</div>
          </div>
        </div>
      </div>

      {/* Status */}
      {status && <div className="status-message">{status}</div>}

      {/* Controls */}
      <div className="collection-controls">
        <div className="controls-left">
          <input
            type="text"
            placeholder="Search collections or NFTs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="input search-input"
          />
          
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="input sort-select"
          >
            <option value="count">Sort by Count</option>
            <option value="name">Sort by Name</option>
            <option value="updated">Sort by Updated</option>
          </select>
          
          <div className="view-toggle">
            <button
              className={`view-toggle-button ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              ⊞
            </button>
            <button
              className={`view-toggle-button ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title="List view"
            >
              ☰
            </button>
          </div>
        </div>
        
        <div className="controls-right">
          {!profileId ? (
            <button
              className="primary-button"
              onClick={ensureProfile}
              disabled={isEnsuring}
            >
              {isEnsuring ? '⏳ Setting up...' : '🔐 Setup Profile'}
            </button>
          ) : (
            <button
              className="secondary-button"
              onClick={requestRefresh}
              disabled={isLoading}
            >
              🔄 Refresh
            </button>
          )}
        </div>
      </div>

      {/* Collections */}
      <div className="collections-container">
        {isLoading ? (
          <div className="loading-container">
            <div className="loading-spinner"></div>
            <p>Loading your NFT collection...</p>
          </div>
        ) : collections.length > 0 ? (
          <div className={`collections-${viewMode}`}>
            {collections.map((collection) => {
              const isExpanded = expandedCollections.has(collection.contract_address);
              
              return (
                <div key={collection.contract_address} className="collection-group card">
                  <div 
                    className="collection-header"
                    onClick={() => toggleCollection(collection.contract_address)}
                  >
                    <div className="collection-info">
                      <h3>
                        {collection.collection_name}
                        {collection.collection_symbol && ` (${collection.collection_symbol})`}
                      </h3>
                      <p className="collection-meta">
                        {collection.token_count} NFTs • {collection.token_standard}
                        {collection.total_balance > collection.token_count && 
                          ` • ${collection.total_balance} total balance`
                        }
                      </p>
                    </div>
                    <div className="collection-toggle">
                      {isExpanded ? '▼' : '▶'}
                    </div>
                  </div>
                  
                  {isExpanded && (
                    <div className={`collection-nfts nfts-${viewMode}`}>
                      {collection.tokens.map((nft) => (
                        <div key={`${nft.contract_address}-${nft.token_id}`} className="nft-card">
                          <div className="nft-image">
                            <img
                              src={nft.image_url || generateFallbackImage(nft.contract_address, nft.token_id)}
                              alt={nft.name || `NFT #${nft.token_id}`}
                              onError={(e) => {
                                e.target.onerror = null;
                                e.target.src = generateFallbackImage(nft.contract_address, nft.token_id);
                              }}
                            />
                          </div>
                          <div className="nft-details">
                            <h4>{nft.name || `NFT #${nft.token_id}`}</h4>
                            <p className="nft-id">Token ID: {nft.token_id}</p>
                            {nft.token_standard === 'ERC1155' && parseInt(nft.balance) > 1 && (
                              <p className="nft-balance">Balance: {nft.balance}</p>
                            )}
                          </div>
                          <div className="nft-actions">
                            <button
                              className="primary-button small"
                              onClick={() => navigate(`/sell?contract=${nft.contract_address}&tokenId=${nft.token_id}`)}
                            >
                              List for Sale
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : profileId ? (
          <div className="empty-state card">
            <div className="empty-icon">🔍</div>
            <h3>No NFTs Found</h3>
            <p>No NFTs found in your wallet. Try refreshing to scan for new tokens.</p>
            <button
              className="primary-button"
              onClick={requestRefresh}
            >
              🔄 Scan for NFTs
            </button>
          </div>
        ) : (
          <div className="empty-state card">
            <div className="empty-icon">🔐</div>
            <h3>Setup Required</h3>
            <p>Click "Setup Profile" to verify your wallet and scan for NFTs.</p>
            <button
              className="primary-button"
              onClick={ensureProfile}
              disabled={isEnsuring}
            >
              {isEnsuring ? '⏳ Setting up...' : '🔐 Setup Profile'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default MyCollections;