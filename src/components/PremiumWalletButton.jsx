import React, { useState } from 'react'
import { Copy, ExternalLink, LogOut, User, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppKit } from '@reown/appkit/react'
import { usePremiumWallet } from '../context/PremiumWalletContext'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { cn } from '../lib/utils'
import blockies from 'ethereum-blockies-base64'

// Shorten address utility
function shortenAddress(address) {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function PremiumWalletButton() {
  const { open } = useAppKit()
  const { address, isConnected, isConnecting, disconnect, isCorrectNetwork, switchToVitruveo } = usePremiumWallet()
  const [copied, setCopied] = useState(false)

  const handleCopyAddress = async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy address:', error)
    }
  }

  const handleDisconnect = async () => {
    await disconnect()
  }

  const handleViewOnExplorer = () => {
    if (address) {
      window.open(`https://explorer.vitruveo.xyz/address/${address}`, '_blank')
    }
  }

  // Generate blockie avatar
  const avatarSrc = address ? blockies(address) : null

  // If not connected, show connect button
  if (!isConnected) {
    return (
      <Button
        onClick={() => open()}
        disabled={isConnecting}
        variant="cyber"
        size="sm"
        className="relative overflow-hidden"
      >
        <motion.div
          initial={false}
          animate={isConnecting ? { rotate: 360 } : { rotate: 0 }}
          transition={{ duration: 1, repeat: isConnecting ? Infinity : 0 }}
        >
          <User className="mr-2 h-4 w-4" />
        </motion.div>
        {isConnecting ? 'Connecting…' : 'Connect Wallet'}
      </Button>
    )
  }

  return (
    <div className="flex items-center space-x-2">
      {/* Network switch button if on wrong network */}
      {!isCorrectNetwork && (
        <Button
          onClick={switchToVitruveo}
          variant="neon-pink"
          size="sm"
          className="text-xs"
        >
          Switch to Vitruveo
        </Button>
      )}

      {/* Account dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "flex items-center space-x-2 px-3 py-2 h-auto",
              "hover:bg-accent transition-colors duration-200",
              isCorrectNetwork 
                ? "border-neon-green/30 bg-neon-green/5" 
                : "border-neon-pink/30 bg-neon-pink/5"
            )}
          >
            <Avatar className="h-6 w-6">
              {avatarSrc && <AvatarImage src={avatarSrc} alt="Wallet Avatar" />}
              <AvatarFallback className="text-xs bg-primary/20">
                {address?.slice(2, 4).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="font-mono text-sm">
              {shortenAddress(address)}
            </span>
            
            {/* Network indicator */}
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                isCorrectNetwork 
                  ? "bg-neon-green animate-pulse" 
                  : "bg-neon-pink animate-pulse"
              )}
            />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent 
          align="end" 
          className="w-64 p-2 bg-card/95 backdrop-blur-sm border-border"
        >
          {/* Account info */}
          <div className="px-2 py-3 border-b border-border">
            <div className="flex items-center space-x-3">
              <Avatar className="h-10 w-10">
                {avatarSrc && <AvatarImage src={avatarSrc} alt="Wallet Avatar" />}
                <AvatarFallback className="bg-primary/20">
                  {address?.slice(2, 4).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm truncate">
                  {address}
                </p>
                <p className={cn(
                  "text-xs mt-1",
                  isCorrectNetwork ? "text-neon-green" : "text-neon-pink"
                )}>
                  {isCorrectNetwork ? "Connected to Vitruveo" : "Wrong Network"}
                </p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="py-1">
            <DropdownMenuItem 
              onClick={handleCopyAddress}
              className="flex items-center space-x-2 cursor-pointer"
            >
              {copied ? (
                <Check className="h-4 w-4 text-neon-green" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span>{copied ? 'Copied!' : 'Copy Address'}</span>
            </DropdownMenuItem>

            <DropdownMenuItem 
              onClick={handleViewOnExplorer}
              className="flex items-center space-x-2 cursor-pointer"
            >
              <ExternalLink className="h-4 w-4" />
              <span>View on Explorer</span>
            </DropdownMenuItem>

            {!isCorrectNetwork && (
              <DropdownMenuItem 
                onClick={switchToVitruveo}
                className="flex items-center space-x-2 cursor-pointer text-neon-pink"
              >
                <div className="h-4 w-4 rounded-full bg-neon-pink" />
                <span>Switch to Vitruveo</span>
              </DropdownMenuItem>
            )}
          </div>

          <DropdownMenuSeparator />

          {/* Disconnect */}
          <div className="py-1">
            <DropdownMenuItem 
              onClick={handleDisconnect}
              className="flex items-center space-x-2 cursor-pointer text-destructive hover:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              <span>Disconnect</span>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}