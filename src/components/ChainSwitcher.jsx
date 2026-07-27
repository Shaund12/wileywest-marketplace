import React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CHAINS, getActiveChainId, setActiveChainId } from '../config/chains.js';
import { usePremiumWallet } from '../context/PremiumWalletContext';

/**
 * ChainSwitcher — the multichain selector. Lets the user switch the whole app
 * between Hyve and Vitruveo. Switching:
 *   1. persists the choice to the registry (setActiveChainId → localStorage),
 *   2. asks the connected wallet to switch to that network (best-effort),
 *   3. reloads so every module re-reads the active chain (RPC, marketplace,
 *      explorer, feature gates) from the registry.
 */
export default function ChainSwitcher() {
    const activeId = getActiveChainId();
    const active = CHAINS[activeId];
    const chains = Object.values(CHAINS);

    // switchToChain prompts the wallet; safe to call even when disconnected.
    let switchToChain;
    try { ({ switchToChain } = usePremiumWallet()); } catch { switchToChain = null; }

    const selectChain = async (id) => {
        if (id === activeId) return;
        setActiveChainId(id);
        // Best-effort: nudge the wallet onto the new network before reload.
        try { if (switchToChain) await switchToChain(id); } catch { /* user can switch in-wallet */ }
        // Reload so the whole app re-points at the newly active chain.
        window.location.reload();
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2.5"
                    aria-label={`Network: ${active.name}. Click to switch chains.`}
                >
                    <span className="text-base leading-none" aria-hidden="true">{active.icon}</span>
                    <span className="hidden sm:inline font-semibold">{active.name}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[10rem]">
                {chains.map((c) => (
                    <DropdownMenuItem
                        key={c.id}
                        onClick={() => selectChain(c.id)}
                        className={cn('gap-2 cursor-pointer', c.id === activeId && 'font-semibold')}
                    >
                        <span className="text-base leading-none" aria-hidden="true">{c.icon}</span>
                        <span className="flex-1">{c.name}</span>
                        <span className="text-xs opacity-60">{c.symbol}</span>
                        {c.id === activeId && <Check className="h-3.5 w-3.5 text-neon-green" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
