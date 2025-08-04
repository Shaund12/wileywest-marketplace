import React, { createContext, useState, useContext } from 'react';
import { ethers } from 'ethers';
import { formatErrorMessage, logError, safeAsync } from '../utils/errorUtils';

const WalletContext = createContext();

export function WalletProvider({ children, rpcUrl }) {
  const [wallet, setWallet] = useState(null);
  const [signer, setSigner] = useState(null);
  const [error, setError] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const connect = async () => {
    if (!window.ethereum) {
      const errorMsg = 'MetaMask is not installed. Please install MetaMask to connect your wallet.';
      setError(errorMsg);
      alert(errorMsg);
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      
      // Use BrowserProvider instead of Web3Provider for ethers v6
      const web3Provider = new ethers.BrowserProvider(window.ethereum);
      const s = await web3Provider.getSigner(); // getSigner is async in v6
      const address = await s.getAddress();
      
      setWallet(address);
      setSigner(s);
      setError(null);
      
      return { address, signer: s };
    } catch (error) {
      const userFriendlyError = formatErrorMessage(error, 'Failed to connect wallet');
      setError(userFriendlyError);
      logError(error, 'Wallet Connection', { rpcUrl });
      
      // Don't show alert for user rejection
      if (!error.message?.includes('user rejected')) {
        console.error("Connection error:", userFriendlyError);
      }
    } finally {
      setIsConnecting(false);
    }
  };
  
  const disconnect = () => {
    setWallet(null);
    setSigner(null);
    setError(null);
  };

  const clearError = () => {
    setError(null);
  };

  return (
    <WalletContext.Provider value={{ 
      wallet, 
      signer, 
      provider, 
      connect, 
      disconnect, 
      error, 
      clearError, 
      isConnecting 
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}