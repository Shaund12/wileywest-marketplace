import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ethers } from 'https://esm.sh/ethers@6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface NFTMetadata {
  name?: string
  description?: string
  image?: string
  image_url?: string
  imageUrl?: string
  attributes?: Array<{
    trait_type?: string
    name?: string
    value: any
    rarity_percentage?: number
  }>
}

interface NFTToken {
  contract: string
  tokenId: string
  balance: string
  metadataUrl?: string
  name?: string
  image?: string
  standard: 'ERC721' | 'ERC1155'
  collectionName?: string
  collectionSymbol?: string
}

// Standard NFT ABIs
const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)', 
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]

const ERC1155_ABI = [
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
  'function uri(uint256 id) view returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]

// Known NFT contracts on Vitruveo
const KNOWN_NFT_CONTRACTS = [
  '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
  // Add more known contracts here
]

// Fetch metadata from URI with multiple fallbacks
async function fetchMetadata(uri: string): Promise<NFTMetadata | null> {
  if (!uri) return null
  
  try {
    // Handle IPFS URIs
    let resolvedUri = uri
    if (uri.startsWith('ipfs://')) {
      const cid = uri.replace('ipfs://', '')
      // Try multiple IPFS gateways
      const gateways = [
        'https://gateway.pinata.cloud/ipfs/',
        'https://dweb.link/ipfs/',
        'https://ipfs.io/ipfs/',
        'https://cloudflare-ipfs.com/ipfs/'
      ]
      
      for (const gateway of gateways) {
        try {
          resolvedUri = `${gateway}${cid}`
          const response = await fetch(resolvedUri, { 
            signal: AbortSignal.timeout(10000) // 10s timeout per gateway
          })
          
          if (response.ok) {
            const metadata = await response.json()
            return metadata as NFTMetadata
          }
        } catch (error) {
          console.warn(`Gateway ${gateway} failed:`, error.message)
          continue
        }
      }
      return null
    }
    
    // Handle data URIs
    if (uri.startsWith('data:application/json,')) {
      const jsonData = decodeURIComponent(uri.split(',')[1])
      return JSON.parse(jsonData) as NFTMetadata
    }
    
    // Handle regular HTTP URIs
    const response = await fetch(resolvedUri, {
      signal: AbortSignal.timeout(15000), // 15s timeout
      headers: {
        'Accept': 'application/json'
      }
    })
    
    if (response.ok) {
      const metadata = await response.json()
      return metadata as NFTMetadata
    }
    
    return null
  } catch (error) {
    console.error('Metadata fetch error:', error)
    return null
  }
}

// Get contract info (name, symbol)
async function getContractInfo(provider: ethers.JsonRpcProvider, contractAddress: string, standard: string) {
  try {
    const abi = standard === 'ERC721' ? ERC721_ABI : ERC1155_ABI
    const contract = new ethers.Contract(contractAddress, abi, provider)
    
    let name = ''
    let symbol = ''
    
    try {
      name = await contract.name()
    } catch { /* optional */ }
    
    try {
      symbol = await contract.symbol()
    } catch { /* optional */ }
    
    return {
      name: name || `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`,
      symbol: symbol || ''
    }
  } catch (error) {
    console.error('Contract info error:', error)
    return {
      name: `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`,
      symbol: ''
    }
  }
}

// Detect if contract is ERC721 or ERC1155
async function detectNFTStandard(provider: ethers.JsonRpcProvider, contractAddress: string, walletAddress: string): Promise<'ERC721' | 'ERC1155' | null> {
  try {
    // Try ERC721 first
    const erc721Contract = new ethers.Contract(contractAddress, ERC721_ABI, provider)
    await erc721Contract.balanceOf(walletAddress)
    return 'ERC721'
  } catch {
    try {
      // Try ERC1155
      const erc1155Contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider)
      await erc1155Contract.balanceOf(walletAddress, 1)
      return 'ERC1155'
    } catch {
      return null
    }
  }
}

// Scan wallet for NFTs using Transfer events
async function scanWalletNFTs(provider: ethers.JsonRpcProvider, walletAddress: string, chainId: number): Promise<NFTToken[]> {
  const nfts: NFTToken[] = []
  const processedContracts = new Set<string>()
  
  try {
    // Get current block
    const currentBlock = await provider.getBlockNumber()
    const fromBlock = Math.max(0, currentBlock - 100000) // Look back 100k blocks (~3-4 days on most chains)
    
    console.log(`Scanning wallet ${walletAddress} from block ${fromBlock} to ${currentBlock}`)
    
    // Scan known contracts first
    for (const contractAddress of KNOWN_NFT_CONTRACTS) {
      if (processedContracts.has(contractAddress.toLowerCase())) continue
      
      try {
        const standard = await detectNFTStandard(provider, contractAddress, walletAddress)
        if (!standard) continue
        
        const contractInfo = await getContractInfo(provider, contractAddress, standard)
        const contract = new ethers.Contract(contractAddress, standard === 'ERC721' ? ERC721_ABI : ERC1155_ABI, provider)
        
        if (standard === 'ERC721') {
          const balance = await contract.balanceOf(walletAddress)
          console.log(`ERC721 ${contractAddress}: balance ${balance}`)
          
          for (let i = 0; i < Math.min(Number(balance), 50); i++) { // Limit to 50 tokens per contract
            try {
              const tokenId = await contract.tokenOfOwnerByIndex(walletAddress, i)
              let tokenURI = ''
              try {
                tokenURI = await contract.tokenURI(tokenId)
              } catch { /* optional */ }
              
              nfts.push({
                contract: contractAddress.toLowerCase(),
                tokenId: tokenId.toString(),
                balance: '1',
                metadataUrl: tokenURI,
                standard: 'ERC721',
                collectionName: contractInfo.name,
                collectionSymbol: contractInfo.symbol
              })
            } catch (error) {
              console.warn(`Error getting token ${i} from ${contractAddress}:`, error)
            }
          }
        } else if (standard === 'ERC1155') {
          // For ERC1155, we need to check specific token IDs
          // This is a simplified approach - in practice you'd track these from events
          const commonTokenIds = [1, 2, 3, 4, 5] // Check some common token IDs
          
          for (const tokenId of commonTokenIds) {
            try {
              const balance = await contract.balanceOf(walletAddress, tokenId)
              if (balance > 0) {
                let tokenURI = ''
                try {
                  tokenURI = await contract.uri(tokenId)
                  // ERC1155 URIs often have {id} placeholder
                  tokenURI = tokenURI.replace('{id}', tokenId.toString())
                } catch { /* optional */ }
                
                nfts.push({
                  contract: contractAddress.toLowerCase(),
                  tokenId: tokenId.toString(),
                  balance: balance.toString(),
                  metadataUrl: tokenURI,
                  standard: 'ERC1155',
                  collectionName: contractInfo.name,
                  collectionSymbol: contractInfo.symbol
                })
              }
            } catch (error) {
              console.warn(`Error checking ERC1155 token ${tokenId}:`, error)
            }
          }
        }
        
        processedContracts.add(contractAddress.toLowerCase())
      } catch (error) {
        console.warn(`Error scanning known contract ${contractAddress}:`, error)
      }
    }
    
    // Also scan recent Transfer events to discover new contracts
    try {
      const transferFilter = {
        topics: [
          [
            ethers.id('Transfer(address,address,uint256)'), // ERC721
            ethers.id('TransferSingle(address,address,address,uint256,uint256)') // ERC1155
          ],
          null, // from
          ethers.zeroPadValue(walletAddress, 32) // to (receiving NFTs)
        ],
        fromBlock,
        toBlock: currentBlock
      }
      
      const logs = await provider.getLogs(transferFilter)
      console.log(`Found ${logs.length} recent transfer events`)
      
      // Process up to 50 recent transfers to avoid timeouts
      for (const log of logs.slice(-50)) {
        const contractAddress = log.address.toLowerCase()
        if (processedContracts.has(contractAddress)) continue
        
        try {
          const standard = await detectNFTStandard(provider, contractAddress, walletAddress)
          if (!standard) continue
          
          const contractInfo = await getContractInfo(provider, contractAddress, standard)
          processedContracts.add(contractAddress)
          
          // Just add a sample to avoid deep scanning every discovered contract
          console.log(`Discovered ${standard} contract: ${contractAddress}`)
        } catch (error) {
          console.warn(`Error processing discovered contract ${contractAddress}:`, error)
        }
      }
    } catch (error) {
      console.warn('Error scanning transfer events:', error)
    }
    
  } catch (error) {
    console.error('Wallet scan error:', error)
  }
  
  return nfts
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
    const rpcUrl = Deno.env.get('RPC_URL') || 'https://rpc.vitruveo.xyz'
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const provider = new ethers.JsonRpcProvider(rpcUrl)

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { 
          status: 405, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Get batch of wallets to sync (up to 25)
    const { data: walletsToSync, error: walletError } = await supabase
      .rpc('get_next_wallet_for_sync')
      .limit(25)

    if (walletError) {
      console.error('Error getting wallets to sync:', walletError)
      return new Response(
        JSON.stringify({ error: 'Failed to get wallets to sync', details: walletError.message }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    if (!walletsToSync || walletsToSync.length === 0) {
      return new Response(
        JSON.stringify({ 
          message: 'No wallets to sync',
          processed: 0
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    console.log(`Processing ${walletsToSync.length} wallets for sync`)
    
    const results = []
    
    for (const walletData of walletsToSync) {
      const { wallet_address, chain_id, sync_id } = walletData
      
      try {
        console.log(`Syncing wallet ${wallet_address} on chain ${chain_id}`)
        
        // Mark sync as started
        await supabase
          .from('sync_queue')
          .update({ 
            status: 'processing', 
            started_at: new Date().toISOString() 
          })
          .eq('id', sync_id)
        
        // Update wallet sync status
        await supabase
          .from('wallets')
          .update({ sync_status: 'syncing' })
          .eq('address', wallet_address)
        
        // Scan wallet for NFTs
        const nfts = await scanWalletNFTs(provider, wallet_address, chain_id)
        console.log(`Found ${nfts.length} NFTs for wallet ${wallet_address}`)
        
        // Fetch metadata for NFTs (in batches to avoid timeouts)
        const batchSize = 10
        for (let i = 0; i < nfts.length; i += batchSize) {
          const batch = nfts.slice(i, i + batchSize)
          
          await Promise.all(batch.map(async (nft) => {
            if (nft.metadataUrl) {
              try {
                const metadata = await fetchMetadata(nft.metadataUrl)
                if (metadata) {
                  nft.name = metadata.name || `NFT #${nft.tokenId}`
                  nft.image = metadata.image || metadata.image_url || metadata.imageUrl
                }
              } catch (error) {
                console.warn(`Failed to fetch metadata for ${nft.contract}:${nft.tokenId}:`, error)
              }
            }
          }))
        }
        
        // Delete existing holdings for this wallet to do a full refresh
        await supabase
          .from('nft_holdings')
          .delete()
          .eq('wallet_address', wallet_address)
          .eq('chain_id', chain_id)
        
        // Insert new holdings
        if (nfts.length > 0) {
          const holdingsData = nfts.map(nft => ({
            wallet_address,
            contract_address: nft.contract,
            token_id: nft.tokenId,
            chain_id,
            balance: nft.balance,
            metadata_url: nft.metadataUrl,
            name: nft.name,
            image_url: nft.image,
            token_standard: nft.standard,
            collection_name: nft.collectionName,
            collection_symbol: nft.collectionSymbol,
            updated_at: new Date().toISOString()
          }))
          
          const { error: insertError } = await supabase
            .from('nft_holdings')
            .insert(holdingsData)
          
          if (insertError) {
            console.error('Error inserting NFT holdings:', insertError)
            throw insertError
          }
        }
        
        // Update wallet sync status
        await supabase
          .from('wallets')
          .update({
            needs_sync: false,
            sync_status: 'completed',
            last_synced_at: new Date().toISOString(),
            sync_error: null
          })
          .eq('address', wallet_address)
        
        // Mark sync as completed
        await supabase
          .from('sync_queue')
          .update({ 
            status: 'completed', 
            completed_at: new Date().toISOString() 
          })
          .eq('id', sync_id)
        
        results.push({
          wallet: wallet_address,
          nftCount: nfts.length,
          status: 'success'
        })
        
        console.log(`✅ Completed sync for wallet ${wallet_address}: ${nfts.length} NFTs`)
        
      } catch (error) {
        console.error(`❌ Error syncing wallet ${wallet_address}:`, error)
        
        // Update wallet with error status
        await supabase
          .from('wallets')
          .update({
            sync_status: 'error',
            sync_error: error.message
          })
          .eq('address', wallet_address)
        
        // Mark sync as failed
        await supabase
          .from('sync_queue')
          .update({ 
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: error.message
          })
          .eq('id', sync_id)
        
        results.push({
          wallet: wallet_address,
          status: 'error',
          error: error.message
        })
      }
    }
    
    // Cleanup old sync queue entries
    await supabase.rpc('cleanup_sync_queue')
    
    return new Response(
      JSON.stringify({
        message: `Processed ${walletsToSync.length} wallets`,
        processed: walletsToSync.length,
        results
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('sync_wallet error:', error)
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