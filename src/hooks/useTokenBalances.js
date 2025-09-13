import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { usePremiumWallet } from '../context/PremiumWalletContext'
import ERC20ABI from '../abi/ERC20.json'
import { convertToUSDCValue } from '../utils/tokenUtils'

// Token addresses from environment
const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS || '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF'
const WVTRU_ADDRESS = import.meta.env.VITE_WVTRU_ADDRESS || '0x3ccc3F22462cAe34766820894D04a40381201ef9'

// Custom hook for fetching token balances
export function useTokenBalances() {
  const { address, provider, isConnected } = usePremiumWallet()
  const [balances, setBalances] = useState({
    vtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: true, error: null },
    usdc: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: true, error: null },
    wvtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: true, error: null },
  })
  const [isLoading, setIsLoading] = useState(false)

  const fetchBalance = useCallback(async (tokenAddress, decimals = 18, symbol = 'TOKEN') => {
    if (!provider || !address) {
      throw new Error('Provider or address not available')
    }

    try {
      let balance
      if (tokenAddress === 'native') {
        // Native VTRU balance
        balance = await provider.getBalance(address)
      } else {
        // ERC20 token balance
        const contract = new ethers.Contract(tokenAddress, ERC20ABI, provider)
        balance = await contract.balanceOf(address)
        
        // Try to get decimals from contract if not provided
        if (decimals === 18) {
          try {
            decimals = await contract.decimals()
          } catch (e) {
            console.warn(`Failed to get decimals for ${symbol}, using default 18`)
            decimals = 18
          }
        }
      }

      const formatted = ethers.formatUnits(balance, decimals)
      const numericValue = parseFloat(formatted)
      const displayValue = numericValue.toFixed(3)

      // Calculate USDC value
      let usdcValue = '0.00'
      try {
        if (symbol === 'USDC') {
          // USDC is already 1:1 with USD
          usdcValue = numericValue.toFixed(2)
        } else {
          // Convert other tokens to USDC value
          const tokenAddressForConversion = tokenAddress === 'native' ? ethers.ZeroAddress : tokenAddress
          const usdcAmount = await convertToUSDCValue(balance.toString(), tokenAddressForConversion, provider)
          usdcValue = usdcAmount.toFixed(2)
        }
      } catch (error) {
        console.warn(`Failed to get USDC value for ${symbol}:`, error)
        usdcValue = '0.00'
      }

      return {
        value: balance.toString(),
        formatted: displayValue,
        usdcValue,
        loading: false,
        error: null
      }
    } catch (error) {
      console.error(`Error fetching ${symbol} balance:`, error)
      return {
        value: '0',
        formatted: '0.000',
        usdcValue: '0.00',
        loading: false,
        error: error.message
      }
    }
  }, [provider, address])

  const fetchAllBalances = useCallback(async () => {
    if (!isConnected || !address || !provider) {
      setBalances({
        vtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: 'Not connected' },
        usdc: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: 'Not connected' },
        wvtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: 'Not connected' },
      })
      return
    }

    setIsLoading(true)
    
    try {
      // Fetch all balances concurrently
      const [vtruResult, usdcResult, wvtruResult] = await Promise.allSettled([
        fetchBalance('native', 18, 'VTRU'),
        fetchBalance(USDC_ADDRESS, 6, 'USDC'), // USDC typically has 6 decimals
        fetchBalance(WVTRU_ADDRESS, 18, 'wVTRU'),
      ])

      setBalances({
        vtru: vtruResult.status === 'fulfilled' ? vtruResult.value : {
          value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: vtruResult.reason?.message || 'Failed to fetch'
        },
        usdc: usdcResult.status === 'fulfilled' ? usdcResult.value : {
          value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: usdcResult.reason?.message || 'Failed to fetch'
        },
        wvtru: wvtruResult.status === 'fulfilled' ? wvtruResult.value : {
          value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: wvtruResult.reason?.message || 'Failed to fetch'
        },
      })
    } catch (error) {
      console.error('Error fetching balances:', error)
      setBalances({
        vtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: error.message },
        usdc: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: error.message },
        wvtru: { value: '0', formatted: '0.000', usdcValue: '0.00', loading: false, error: error.message },
      })
    } finally {
      setIsLoading(false)
    }
  }, [isConnected, address, provider, fetchBalance])

  // Effect to fetch balances when wallet connects or changes
  useEffect(() => {
    fetchAllBalances()
  }, [fetchAllBalances])

  // Return hook values and functions
  return {
    balances,
    isLoading,
    refetch: fetchAllBalances,
    fetchBalance,
  }
}

// Individual hooks for specific tokens (convenience)
export function useVTRUBalance() {
  const { balances } = useTokenBalances()
  return balances.vtru
}

export function useUSDCBalance() {
  const { balances } = useTokenBalances()
  return balances.usdc
}

export function useWVTRUBalance() {
  const { balances } = useTokenBalances()
  return balances.wvtru
}