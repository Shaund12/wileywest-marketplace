import React, { createContext, useState, useContext } from 'react';
import { ethers } from 'ethers';

const WalletContext = createContext();

export function WalletProvider({ children, rpcUrl }) {
  const [wallet, setWallet] = useState(null);
  const [signer, setSigner] = useState(null);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  const connect = async () => {
    if (!window.ethereum) {
      alert('Install MetaMask');
      return;
    }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      // Use BrowserProvider instead of Web3Provider for ethers v6
      const web3Provider = new ethers.BrowserProvider(window.ethereum);
      const s = await web3Provider.getSigner(); // getSigner is async in v6
      const address = await s.getAddress();
      setWallet(address);
      setSigner(s);
      return { address, signer: s };
    } catch (error) {
      console.error("Connection error:", error);
    }
  };
  
  const disconnect = () => {
    setWallet(null);
    setSigner(null);
  };

  return (
    <WalletContext.Provider value={{ wallet, signer, provider, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}