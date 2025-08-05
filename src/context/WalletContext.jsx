import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

// Create context
const WalletContext = createContext();

export function WalletProvider({ children }) {
    const [wallet, setWallet] = useState(null);
    const [provider, setProvider] = useState(null);
    const [signer, setSigner] = useState(null);
    const [chainId, setChainId] = useState(null);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [isInitialized, setIsInitialized] = useState(false);

    // Initialize provider safely
    const initializeProvider = useCallback(async () => {
        if (!window.ethereum) return null;

        try {
            const ethersProvider = new ethers.BrowserProvider(window.ethereum);
            // Validate provider by making a simple call
            await ethersProvider.getNetwork();
            return ethersProvider;
        } catch (error) {
            console.error("Provider initialization error:", error);
            return null;
        }
    }, []);

    // Get signer safely
    const getSigner = useCallback(async (ethersProvider) => {
        if (!ethersProvider) return null;
        
        try {
            return await ethersProvider.getSigner();
        } catch (error) {
            console.error("Failed to get signer:", error);
            return null;
        }
    }, []);

    // Update wallet state
    const updateWalletState = useCallback(async (address, ethersProvider) => {
        if (!address || !ethersProvider) {
            setWallet(null);
            setSigner(null);
            setChainId(null);
            return;
        }

        try {
            // Get signer
            const ethersSigner = await getSigner(ethersProvider);
            
            // Get network info
            let network;
            try {
                network = await ethersProvider.getNetwork();
            } catch (error) {
                console.error("Failed to get network:", error);
                network = { chainId: 0 };
            }

            // Update state atomically to prevent race conditions
            setWallet(address);
            setSigner(ethersSigner);
            setChainId(network.chainId);
            setProvider(ethersProvider);
        } catch (error) {
            console.error("Error updating wallet state:", error);
            // On failure, clear state to prevent inconsistency
            setWallet(null);
            setSigner(null);
            setChainId(null);
        }
    }, [getSigner]);

    // Initialize wallet from stored state
    useEffect(() => {
        const initializeWallet = async () => {
            if (isInitialized) return;
            
            try {
                setIsConnecting(true);
                
                // Check if user was previously connected
                const savedWalletState = localStorage.getItem('walletConnected');
                
                if (savedWalletState === 'true' && window.ethereum) {
                    // Initialize provider
                    const ethersProvider = await initializeProvider();
                    if (!ethersProvider) {
                        throw new Error("Could not initialize provider");
                    }
                    
                    // Try to get accounts without prompting
                    const accounts = await window.ethereum.request({ 
                        method: 'eth_accounts'
                    });
                    
                    if (accounts && accounts.length > 0) {
                        // Update wallet state with the account
                        await updateWalletState(accounts[0], ethersProvider);
                        localStorage.setItem('walletConnected', 'true');
                    } else {
                        // No accounts accessible
                        localStorage.removeItem('walletConnected');
                    }
                } else if (!window.ethereum) {
                    // Set a default read-only provider if MetaMask isn't available
                    setProvider(new ethers.JsonRpcProvider('https://rpc.vitruveo.xyz'));
                }
            } catch (error) {
                console.error("Failed to initialize wallet:", error);
                setConnectionError(error.message);
                localStorage.removeItem('walletConnected');
            } finally {
                setIsConnecting(false);
                setIsInitialized(true);
            }
        };

        initializeWallet();
    }, [initializeProvider, updateWalletState, isInitialized]);

    // Setup event listeners for wallet changes
    useEffect(() => {
        if (!window.ethereum || !isInitialized) return;

        const handleAccountsChanged = async (accounts) => {
            console.log("Accounts changed:", accounts);
            
            if (!accounts || accounts.length === 0) {
                // User disconnected wallet
                setWallet(null);
                setSigner(null);
                localStorage.removeItem('walletConnected');
                console.log("Wallet disconnected");
            } else {
                // Account changed
                const currentProvider = provider || await initializeProvider();
                await updateWalletState(accounts[0], currentProvider);
                localStorage.setItem('walletConnected', 'true');
                console.log("Wallet account updated:", accounts[0]);
            }
        };

        const handleChainChanged = async (chainIdHex) => {
            console.log("Chain changed:", chainIdHex);
            
            // Instead of reloading the page, update the chainId
            try {
                const chainIdDecimal = parseInt(chainIdHex, 16);
                setChainId(chainIdDecimal);
                
                // Refresh provider and signer
                if (wallet) {
                    const refreshedProvider = await initializeProvider();
                    await updateWalletState(wallet, refreshedProvider);
                }
            } catch (error) {
                console.error("Error handling chain change:", error);
            }
        };

        const handleConnect = (connectInfo) => {
            console.log("Wallet connected event:", connectInfo);
            // We'll handle the actual connection in accountsChanged
        };

        const handleDisconnect = (error) => {
            console.log("Wallet disconnect event:", error);
            setWallet(null);
            setSigner(null);
            localStorage.removeItem('walletConnected');
        };

        // Subscribe to wallet events
        window.ethereum.on('accountsChanged', handleAccountsChanged);
        window.ethereum.on('chainChanged', handleChainChanged);
        window.ethereum.on('connect', handleConnect);
        window.ethereum.on('disconnect', handleDisconnect);

        // Cleanup function
        return () => {
            if (window.ethereum?.removeListener) {
                window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
                window.ethereum.removeListener('chainChanged', handleChainChanged);
                window.ethereum.removeListener('connect', handleConnect);
                window.ethereum.removeListener('disconnect', handleDisconnect);
            }
        };
    }, [provider, wallet, isInitialized, initializeProvider, updateWalletState]);

    // Connect wallet function
    const connect = async () => {
        if (!window.ethereum) {
            setConnectionError('MetaMask is not installed. Please install it to use this feature.');
            return false;
        }

        try {
            setIsConnecting(true);
            setConnectionError(null);

            // Initialize provider
            const ethersProvider = await initializeProvider();
            if (!ethersProvider) {
                throw new Error("Could not initialize provider");
            }

            // Request accounts - this triggers the wallet popup
            const accounts = await window.ethereum.request({ 
                method: 'eth_requestAccounts'
            });
            
            if (accounts && accounts.length > 0) {
                // Update wallet state
                await updateWalletState(accounts[0], ethersProvider);
                
                // Store connection state
                localStorage.setItem('walletConnected', 'true');
                return true;
            } else {
                throw new Error("No accounts returned from wallet");
            }
        } catch (error) {
            console.error("Failed to connect wallet:", error);
            setConnectionError(error.message);
            return false;
        } finally {
            setIsConnecting(false);
        }
    };

    // Disconnect wallet function - note that this doesn't actually disconnect MetaMask
    // It just clears our local state
    const disconnect = () => {
        setWallet(null);
        setSigner(null);
        localStorage.removeItem('walletConnected');
        // Maintain the provider for read-only functions
    };

    // Check if the wallet is connected
    const isConnected = wallet !== null && signer !== null;

    return (
        <WalletContext.Provider
            value={{
                wallet,
                provider,
                signer,
                chainId,
                connect,
                disconnect,
                isConnecting,
                connectionError,
                isConnected
            }}>
            {children}
        </WalletContext.Provider>
    );
}

export function useWallet() {
    return useContext(WalletContext);
}