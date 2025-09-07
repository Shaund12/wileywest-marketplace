import { createClient } from '@supabase/supabase-js'

// Supabase client singleton
let supabaseInstance = null

export function getSupabaseClient() {
  if (!supabaseInstance) {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
    
    if (!supabaseUrl || !supabaseAnonKey || supabaseUrl === 'https://dummy.supabase.co') {
      console.warn('Supabase not configured - some features may not work')
      return null
    }
    
    supabaseInstance = createClient(supabaseUrl, supabaseAnonKey)
  }
  
  return supabaseInstance
}

// Database types
export interface Profile {
  id: string
  handle: string
  display_name?: string
  bio?: string
  avatar_url?: string
  created_at: string
  updated_at: string
}

export interface Wallet {
  address: string
  profile_id?: string
  chain_id: number
  last_synced_at?: string
  needs_sync: boolean
  sync_status: 'pending' | 'syncing' | 'completed' | 'error'
  sync_error?: string
  nft_count: number
  created_at: string
  updated_at: string
}

export interface NFTHolding {
  wallet_address: string
  contract_address: string
  token_id: string
  chain_id: number
  balance: string
  metadata_url?: string
  name?: string
  description?: string
  image_url?: string
  attributes?: any[]
  token_standard: 'ERC721' | 'ERC1155'
  collection_name?: string
  collection_symbol?: string
  updated_at: string
}

export interface WalletProfile {
  address: string
  chain_id: number
  last_synced_at?: string
  needs_sync: boolean
  sync_status: string
  nft_count: number
  wallet_created_at: string
  profile_id?: string
  handle?: string
  display_name?: string
  bio?: string
  avatar_url?: string
  profile_created_at?: string
}

// Helper functions
export class SupabaseService {
  private supabase

  constructor() {
    this.supabase = getSupabaseClient()
  }

  get client() {
    return this.supabase
  }

  get isConnected() {
    return this.supabase !== null
  }

  // Wallet and Profile operations
  async getWalletProfile(address: string): Promise<WalletProfile | null> {
    if (!this.supabase) return null
    
    try {
      const { data, error } = await this.supabase
        .from('wallet_profiles')
        .select('*')
        .eq('address', address.toLowerCase())
        .single()
      
      if (error) {
        if (error.code === 'PGRST116') return null // Not found
        throw error
      }
      
      return data
    } catch (error) {
      console.error('Error getting wallet profile:', error)
      return null
    }
  }

  async getNFTHoldings(address: string, chainId: number = 1490): Promise<NFTHolding[]> {
    if (!this.supabase) return []
    
    try {
      const { data, error } = await this.supabase
        .from('nft_holdings')
        .select('*')
        .eq('wallet_address', address.toLowerCase())
        .eq('chain_id', chainId)
        .order('updated_at', { ascending: false })
      
      if (error) throw error
      
      return data || []
    } catch (error) {
      console.error('Error getting NFT holdings:', error)
      return []
    }
  }

  async getCollectionStats(address: string, chainId: number = 1490) {
    if (!this.supabase) return null
    
    try {
      const { data, error } = await this.supabase
        .from('nft_collection_stats')
        .select('*')
        .eq('wallet_address', address.toLowerCase())
        .eq('chain_id', chainId)
        .order('token_count', { ascending: false })
      
      if (error) throw error
      
      return data || []
    } catch (error) {
      console.error('Error getting collection stats:', error)
      return []
    }
  }

  async requestSync(address: string, chainId: number = 1490, priority: number = 5): Promise<boolean> {
    if (!this.supabase) return false
    
    try {
      const { error } = await this.supabase
        .rpc('queue_wallet_sync', {
          p_wallet_address: address.toLowerCase(),
          p_chain_id: chainId,
          p_priority: priority
        })
      
      if (error) throw error
      
      return true
    } catch (error) {
      console.error('Error requesting sync:', error)
      return false
    }
  }

  // Real-time subscriptions
  subscribeToWalletChanges(address: string, callback: (payload: any) => void) {
    if (!this.supabase) return null
    
    return this.supabase
      .channel(`wallet_${address}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `address=eq.${address.toLowerCase()}`
        },
        callback
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'nft_holdings',
          filter: `wallet_address=eq.${address.toLowerCase()}`
        },
        callback
      )
      .subscribe()
  }

  subscribeToNFTChanges(address: string, callback: (payload: any) => void) {
    if (!this.supabase) return null
    
    return this.supabase
      .channel(`nft_${address}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'nft_holdings',
          filter: `wallet_address=eq.${address.toLowerCase()}`
        },
        callback
      )
      .subscribe()
  }
}

export const supabaseService = new SupabaseService()
export default supabaseService