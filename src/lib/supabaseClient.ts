import { createClient } from '@supabase/supabase-js'

// Supabase client singleton
let supabaseInstance = null
let supabaseConfig = null

export function getSupabaseClient() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  
  // Check if configuration changed
  const currentConfig = { url: supabaseUrl, key: supabaseAnonKey }
  
  if (!supabaseInstance || JSON.stringify(supabaseConfig) !== JSON.stringify(currentConfig)) {
    if (!supabaseUrl || !supabaseAnonKey || supabaseUrl === 'https://dummy.supabase.co') {
      console.warn('Supabase not configured - profile features disabled')
      supabaseInstance = null
      supabaseConfig = null
      return null
    }
    
    try {
      supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: false, // Prevent multiple auth instances
          autoRefreshToken: false,
        },
        global: {
          headers: {
            'X-Client-Info': 'wileywest-marketplace'
          }
        }
      })
      supabaseConfig = currentConfig
    } catch (error) {
      console.error('Failed to create Supabase client:', error)
      supabaseInstance = null
      supabaseConfig = null
      return null
    }
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
      
      if (error) {
        console.warn('Sync function not available - backend features may not be deployed:', error.message)
        return false
      }
      
      return true
    } catch (error) {
      console.warn('Background sync not available - this is normal if backend services are not configured')
      return false
    }
  }

  // Check if Edge Functions are available
  async checkEdgeFunctionsAvailable(): Promise<boolean> {
    if (!this.supabase) return false
    
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/health-check`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
        }
      })
      
      return response.ok
    } catch (error) {
      return false
    }
  }

  // Ensure profile with fallback when Edge Functions are not available
  async ensureProfileFallback(address: string, chainId: number = 1490): Promise<{ profileId: string | null, syncQueued: boolean, usingFallback: boolean }> {
    if (!this.supabase) {
      console.log('DEBUG: Supabase client not available')
      return { profileId: null, syncQueued: false, usingFallback: true }
    }

    console.log(`DEBUG: Starting profile creation for wallet ${address}`)

    try {
      // Try to call the Edge Function first (if deployed)
      console.log('DEBUG: Attempting Edge Function call...')
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ensure_profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          wallet: address,
          chainId: chainId,
          message: 'Profile creation fallback - Edge Functions not available',
          signature: 'fallback'
        })
      })
      
      if (response.ok) {
        const result = await response.json()
        console.log('DEBUG: Edge Function succeeded:', result)
        return { profileId: result.profileId, syncQueued: result.syncQueued || false, usingFallback: false }
      } else {
        console.log(`DEBUG: Edge Function failed with status ${response.status}`)
      }
    } catch (error) {
      console.log('DEBUG: Edge Function call failed:', error.message)
    }

    // Fallback: try to create a basic profile record without SIWE verification
    console.log('DEBUG: Using fallback profile creation (direct database)')
    try {
      // Check if wallet already exists
      console.log('DEBUG: Checking if wallet already exists...')
      const existingWallet = await this.getWalletProfile(address)
      if (existingWallet) {
        console.log('DEBUG: Existing wallet found:', existingWallet)
        return { profileId: existingWallet.profile_id || null, syncQueued: false, usingFallback: true }
      }

      console.log('DEBUG: Creating new profile...')
      // Generate a unique handle for this wallet
      const handleSuffix = address.toLowerCase().slice(-8)
      const baseHandle = `user_${handleSuffix}`
      
      // Create a basic profile entry (if the table exists)
      const { data: profileData, error: profileError } = await this.supabase
        .from('profiles')
        .upsert({
          handle: baseHandle,
          display_name: `User ${address.slice(0, 8)}...${address.slice(-6)}`,
        }, {
          onConflict: 'handle',
          ignoreDuplicates: false
        })
        .select()
        .single()

      if (profileError) {
        console.error('DEBUG: Profile creation failed:', profileError)
        
        // Provide specific guidance for RLS policy errors
        if (profileError.message.includes('row-level security policy')) {
          throw new Error(`Profile creation failed: new row violates row-level security policy for table "profiles". This means the database migration "20240907_fix_profile_creation_rls.sql" needs to be run to allow profile creation without Edge Functions. Please run this migration in your Supabase dashboard.`)
        }
        
        throw new Error(`Profile creation failed: ${profileError.message}`)
      }

      console.log('DEBUG: Profile created successfully:', profileData)

      // Create wallet record
      console.log('DEBUG: Creating wallet record...')
      const { error: walletError } = await this.supabase
        .from('wallets')
        .upsert({
          address: address.toLowerCase(),
          profile_id: profileData.id,
          chain_id: chainId,
          needs_sync: true,
          sync_status: 'pending',
          nft_count: 0
        }, {
          onConflict: 'address',
          ignoreDuplicates: false
        })

      if (walletError) {
        console.error('DEBUG: Wallet creation failed:', walletError)
        // Don't fail the entire operation if wallet creation fails
        console.warn('Wallet record creation failed, but profile was created')
      } else {
        console.log('DEBUG: Wallet record created successfully')
      }

      // Try to queue sync (optional)
      try {
        console.log('DEBUG: Attempting to queue sync...')
        await this.requestSync(address, chainId, 1)
        console.log('DEBUG: Sync queued successfully')
      } catch (syncError) {
        console.log('DEBUG: Sync queue failed (this is normal if function not deployed):', syncError.message)
      }

      return { profileId: profileData.id, syncQueued: false, usingFallback: true }
    } catch (error) {
      console.error('DEBUG: Fallback profile creation failed completely:', error)
      throw error
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