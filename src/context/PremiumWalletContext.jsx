import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi'
import { ethers } from 'ethers'
import { vitruveo } from '../config/wagmi'
import { activeChain, CHAINS } from '../config/chains.js'

const PremiumWalletContext = createContext()

export function PremiumWalletProvider({ children }) {
  const { address, isConnected, isConnecting } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  
  const [ethersProvider, setEthersProvider] = useState(null)
  const [ethersSigner, setEthersSigner] = useState(null)
  const [connectionError, setConnectionError] = useState(null)

  // Create ethers provider and signer when connected
  useEffect(() => {
    const setupEthers = async () => {
      if (isConnected && address && window.ethereum) {
        try {
          const provider = new ethers.BrowserProvider(window.ethereum)
          const signer = await provider.getSigner()
          setEthersProvider(provider)
          setEthersSigner(signer)
          setConnectionError(null)
        } catch (error) {
          console.error('Failed to setup ethers:', error)
          setConnectionError(error.message)
          setEthersProvider(null)
          setEthersSigner(null)
        }
      } else {
        // Read-only provider for the ACTIVE chain (Hyve or Vitruveo).
        try {
          // staticNetwork + polling: the /api/rpc proxy rejects eth_newFilter,
          // which otherwise breaks provider startup. See makeReadonlyProvider
          // in WalletContext for the full explanation.
          const chain = activeChain()
          const readOnlyProvider = new ethers.JsonRpcProvider(
            chain.rpcUrl,
            chain.id,
            { staticNetwork: true, polling: true }
          )
          setEthersProvider(readOnlyProvider)
          setEthersSigner(null)
        } catch (error) {
          console.error('Failed to setup read-only provider:', error)
        }
      }
    }

    setupEthers()
  }, [isConnected, address])

  // The connected wallet must match the chain selected in ChainSwitcher.
  const targetChainId = activeChain().id
  const isCorrectNetwork = Number(chainId) === targetChainId

  // Switch the wallet to a specific supported chain (defaults to active).
  const switchToChain = useCallback(async (id = targetChainId) => {
    try {
      await switchChain({ chainId: id })
      return true
    } catch (error) {
      console.error(`Failed to switch to chain ${id}:`, error)
      setConnectionError(error.message)
      return false
    }
  }, [switchChain, targetChainId])

  // Back-compat alias (older callers): switch to the active chain.
  const switchToVitruveo = useCallback(() => switchToChain(targetChainId), [switchToChain, targetChainId])

  const ensureCorrectNetwork = useCallback(async (force = false) => {
    if (Number(chainId) === targetChainId) return true
    if (!force) return false
    return await switchToChain(targetChainId)
  }, [chainId, switchToChain, targetChainId])

  // Wallet connection methods
  const connectWallet = useCallback(async (connectorId) => {
    try {
      setConnectionError(null)
      const connector = connectors.find(c => c.id === connectorId)
      if (!connector) {
        throw new Error(`Connector ${connectorId} not found`)
      }
      await connect({ connector })
      return true
    } catch (error) {
      console.error('Failed to connect wallet:', error)
      setConnectionError(error.message)
      return false
    }
  }, [connect, connectors])

  const disconnectWallet = useCallback(async () => {
    try {
      await disconnect()
      setConnectionError(null)
      return true
    } catch (error) {
      console.error('Failed to disconnect wallet:', error)
      setConnectionError(error.message)
      return false
    }
  }, [disconnect])

  // Ethers compatibility methods
  const signMessage = useCallback(async (message) => {
    if (!ethersSigner) throw new Error('Wallet not connected')
    return await ethersSigner.signMessage(message)
  }, [ethersSigner])

  const signTypedData = useCallback(async (domain, types, value) => {
    if (!ethersSigner) throw new Error('Wallet not connected')
    return await ethersSigner.signTypedData(domain, types, value)
  }, [ethersSigner])

  const sendTransaction = useCallback(async (tx) => {
    if (!ethersSigner) throw new Error('Wallet not connected')
    const resp = await ethersSigner.sendTransaction(tx)
    return await resp.wait()
  }, [ethersSigner])

  const getBalance = useCallback(async (addressToCheck) => {
    const provider = ethersProvider
    if (!provider) throw new Error('No provider available')
    const bal = await provider.getBalance(addressToCheck || address)
    return ethers.formatEther(bal)
  }, [ethersProvider, address])

  const watchAsset = useCallback(async ({ address: tokenAddress, symbol, decimals = 18, image } = {}) => {
    if (!window.ethereum) return false
    try {
      const res = await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: { address: tokenAddress, symbol, decimals, image }
        }
      })
      return !!res
    } catch (e) {
      console.warn('watchAsset failed:', e)
      return false
    }
  }, [])

  const value = {
    // Wagmi state
    address,
    isConnected,
    isConnecting,
    chainId,
    connectors,
    
    // Ethers compatibility
    wallet: address,
    provider: ethersProvider,
    signer: ethersSigner,
    
    // Network utilities (multichain)
    isCorrectNetwork,
    targetChainId,
    switchToChain,
    switchToVitruveo, // back-compat alias → switches to active chain
    ensureCorrectNetwork,
    
    // Connection methods
    connect: connectWallet,
    disconnect: disconnectWallet,
    connectionError,
    
    // Ethers methods
    signMessage,
    signTypedData,
    sendTransaction,
    getBalance,
    watchAsset,
    
    // Status
    status: isConnected ? 'ready' : 'idle'
  }

  return (
    <PremiumWalletContext.Provider value={value}>
      {children}
    </PremiumWalletContext.Provider>
  )
}

export function usePremiumWallet() {
  const context = useContext(PremiumWalletContext)
  if (!context) {
    throw new Error('usePremiumWallet must be used within PremiumWalletProvider')
  }
  return context
}
