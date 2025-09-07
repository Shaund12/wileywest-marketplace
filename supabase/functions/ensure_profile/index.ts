import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ethers } from 'https://esm.sh/ethers@6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface EnsureProfileRequest {
  wallet: string
  chainId: number
  message: string
  signature: string
}

interface SiweMessage {
  domain: string
  address: string
  statement?: string
  uri: string
  version: string
  chainId: number
  nonce: string
  issuedAt: string
  expirationTime?: string
  notBefore?: string
  requestId?: string
  resources?: string[]
}

// Simple SIWE message parser (basic implementation)
function parseSiweMessage(message: string): SiweMessage | null {
  try {
    const lines = message.split('\n').map(line => line.trim()).filter(line => line)
    
    // Extract domain (first line)
    const domain = lines[0] || ''
    
    // Find address, statement, URI, etc.
    let address = ''
    let statement = ''
    let uri = ''
    let version = ''
    let chainId = 0
    let nonce = ''
    let issuedAt = ''
    let expirationTime = ''
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      if (line.match(/^0x[a-fA-F0-9]{40}$/)) {
        address = line
      } else if (line.startsWith('URI: ')) {
        uri = line.substring(5)
      } else if (line.startsWith('Version: ')) {
        version = line.substring(9)
      } else if (line.startsWith('Chain ID: ')) {
        chainId = parseInt(line.substring(10))
      } else if (line.startsWith('Nonce: ')) {
        nonce = line.substring(7)
      } else if (line.startsWith('Issued At: ')) {
        issuedAt = line.substring(11)
      } else if (line.startsWith('Expiration Time: ')) {
        expirationTime = line.substring(17)
      } else if (!line.startsWith('URI:') && !line.startsWith('Version:') && 
                !line.startsWith('Chain ID:') && !line.startsWith('Nonce:') && 
                !line.startsWith('Issued At:') && !line.startsWith('Expiration Time:') &&
                !line.match(/^0x[a-fA-F0-9]{40}$/) && line !== domain) {
        if (!statement) statement = line
      }
    }
    
    return {
      domain,
      address,
      statement,
      uri,
      version,
      chainId,
      nonce,
      issuedAt,
      expirationTime
    }
  } catch (error) {
    console.error('Failed to parse SIWE message:', error)
    return null
  }
}

// Verify SIWE signature
async function verifySiweSignature(message: string, signature: string, expectedAddress: string): Promise<boolean> {
  try {
    // Parse the SIWE message
    const siweData = parseSiweMessage(message)
    if (!siweData) {
      console.error('Failed to parse SIWE message')
      return false
    }
    
    // Verify address matches
    if (siweData.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      console.error('Address mismatch in SIWE message')
      return false
    }
    
    // Check expiration if present
    if (siweData.expirationTime) {
      const expiry = new Date(siweData.expirationTime)
      if (expiry < new Date()) {
        console.error('SIWE message has expired')
        return false
      }
    }
    
    // Verify signature
    const messageHash = ethers.hashMessage(message)
    const recoveredAddress = ethers.recoverAddress(messageHash, signature)
    
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
  } catch (error) {
    console.error('SIWE verification error:', error)
    return false
  }
}

// Generate a default handle from wallet address
function generateDefaultHandle(address: string): string {
  // Use last 8 characters for uniqueness + first 2 for readability
  const suffix = address.slice(-8)
  const prefix = address.slice(2, 4)
  return `user_${prefix}${suffix}`.toLowerCase()
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Initialize Supabase client with service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { 
          status: 405, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    const { wallet, chainId, message, signature }: EnsureProfileRequest = await req.json()

    // Validate inputs
    if (!wallet || !chainId || !message || !signature) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: wallet, chainId, message, signature' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Normalize wallet address
    const normalizedWallet = wallet.toLowerCase()
    
    // Verify wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedWallet)) {
      return new Response(
        JSON.stringify({ error: 'Invalid wallet address format' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Verify SIWE signature
    const isValidSignature = await verifySiweSignature(message, signature, normalizedWallet)
    if (!isValidSignature) {
      return new Response(
        JSON.stringify({ error: 'Invalid SIWE signature' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Check if wallet already exists
    const { data: existingWallet } = await supabase
      .from('wallets')
      .select('address, profile_id, profiles(id, handle)')
      .eq('address', normalizedWallet)
      .single()

    let profileId: string

    if (existingWallet?.profile_id) {
      // Wallet already has a profile
      profileId = existingWallet.profile_id
      console.log(`Wallet ${normalizedWallet} already has profile ${profileId}`)
    } else {
      // Create new profile and link wallet
      const defaultHandle = generateDefaultHandle(normalizedWallet)
      
      // First, upsert the profile
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .upsert({
          handle: defaultHandle,
          display_name: `User ${normalizedWallet.slice(0, 8)}...${normalizedWallet.slice(-6)}`,
        }, {
          onConflict: 'handle',
          ignoreDuplicates: false
        })
        .select('id')
        .single()

      if (profileError) {
        console.error('Profile creation error:', profileError)
        return new Response(
          JSON.stringify({ error: 'Failed to create profile', details: profileError.message }),
          { 
            status: 500, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        )
      }

      profileId = profile.id

      // Now upsert the wallet with the profile_id
      const { error: walletError } = await supabase
        .from('wallets')
        .upsert({
          address: normalizedWallet,
          profile_id: profileId,
          chain_id: chainId,
          needs_sync: true,
          sync_status: 'pending'
        }, {
          onConflict: 'address',
          ignoreDuplicates: false
        })

      if (walletError) {
        console.error('Wallet creation error:', walletError)
        return new Response(
          JSON.stringify({ error: 'Failed to create wallet record', details: walletError.message }),
          { 
            status: 500, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        )
      }

      console.log(`Created new profile ${profileId} for wallet ${normalizedWallet}`)
    }

    // Queue the wallet for sync
    const { error: queueError } = await supabase
      .rpc('queue_wallet_sync', {
        p_wallet_address: normalizedWallet,
        p_chain_id: chainId,
        p_priority: 1 // High priority for new profiles
      })

    if (queueError) {
      console.warn('Failed to queue wallet sync:', queueError)
      // Don't fail the request, just log the warning
    }

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        profileId,
        wallet: normalizedWallet,
        chainId,
        syncQueued: !queueError
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('ensure_profile error:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error', 
        message: error.message 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})