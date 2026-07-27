// src/context/WalletContext.jsx
import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { usePremiumWallet } from './PremiumWalletContext';
import { activeChain } from '../config/chains.js';

const WalletContext = createContext();

// ======= ACTIVE-CHAIN CONFIG (from the multichain registry) =========
// These resolve to whichever chain is active (Hyve or Vitruveo). Switching
// chains reloads the app, so reading once at module load is sufficient.
const _chain = activeChain();
const RPC_URL = _chain.rpcUrl;
const RAW_CHAIN_ID = String(_chain.id);      // decimal string; normalizeChainId handles it
const CHAIN_NAME = _chain.name;
const NATIVE_NAME = _chain.symbol;
const NATIVE_SYMBOL = _chain.symbol;
const NATIVE_DECIMALS = 18;
const EXPLORER_URL = _chain.explorer;

// Parse chain ID from env (decimal/hex) → { num, hex }
function normalizeChainId(id) {
    if (!id) return { num: null, hex: null };
    let num;
    if (typeof id === 'number') num = id;
    else if (typeof id === 'bigint') num = Number(id);
    else if (typeof id === 'string' && id.startsWith('0x')) num = parseInt(id, 16);
    else num = parseInt(String(id), 10);
    if (!Number.isFinite(num) || num <= 0) return { num: null, hex: null };
    const hex = '0x' + num.toString(16);
    return { num, hex };
}
const TARGET = normalizeChainId(RAW_CHAIN_ID);

// EIP-3085 params (used when wallet doesn’t know the chain)
const ADD_CHAIN_PARAMS = TARGET.hex
    ? {
        chainId: TARGET.hex,
        chainName: CHAIN_NAME,
        nativeCurrency: { name: NATIVE_NAME, symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: EXPLORER_URL ? [EXPLORER_URL] : []
    }
    : null;

// ============ PROVIDER HELPERS ============
async function makeBrowserProvider() {
    if (!window.ethereum) return null;
    const provider = new ethers.BrowserProvider(window.ethereum);
    // simple probe
    await provider.getNetwork();
    return provider;
}

async function makeReadonlyProvider() {
    // `polling: true` is required, not a preference. By default ethers v6 sets
    // up event subscriptions with eth_newFilter, which /api/rpc/:chain does not
    // allow — filters are per-node state and would break the moment a request
    // failed over to the explorer fallback. A rejected eth_newFilter makes the
    // provider fail network detection entirely ("failed to detect network and
    // cannot start up"), so every contract.on() listener silently dies.
    // Polling makes ethers use eth_getLogs instead, which is allowlisted.
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { polling: true });
    provider.pollingInterval = 12_000;
    // probe to surface misconfig early
    await provider.getNetwork().catch(() => { });
    return provider;
}

// ============ CONTEXT PROVIDER ============
export function WalletProvider({ children }) {
    const mountedRef = useRef(true);
    const listenersBoundRef = useRef(false);

    const [wallet, setWallet] = useState(null);        // checksummed address
    const [provider, setProvider] = useState(null);    // ethers Provider (RW if connected, else RO)
    const [signer, setSigner] = useState(null);
    const [chainId, setChainId] = useState(null);      // number
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [status, setStatus] = useState('idle');      // idle | initialising | ready | error

    // Integration with PremiumWallet
    const premiumWallet = usePremiumWallet();
    
    // Sync with PremiumWallet state when available
    useEffect(() => {
        if (premiumWallet?.address && premiumWallet?.provider && premiumWallet?.signer) {
            // PremiumWallet is connected, sync the state
            setWallet(premiumWallet.address);
            setProvider(premiumWallet.provider);
            setSigner(premiumWallet.signer);
            setChainId(premiumWallet.chainId);
            setStatus('ready');
            setConnectionError(null);
            setIsConnecting(false);
        } else if (!premiumWallet?.isConnected && premiumWallet?.address === undefined) {
            // PremiumWallet is disconnected, reset legacy state
            setWallet(null);
            setSigner(null);
            setStatus('idle');
            setConnectionError(null);
            setIsConnecting(false);
        }
    }, [
        premiumWallet?.address, 
        premiumWallet?.isConnected, 
        premiumWallet?.provider, 
        premiumWallet?.signer,
        premiumWallet?.chainId
    ]);

    // Guarded state setters
    const safeSet = (fn) => (...args) => { if (mountedRef.current) fn(...args); };

    const _setWallet = safeSet(setWallet);
    const _setProvider = safeSet(setProvider);
    const _setSigner = safeSet(setSigner);
    const _setChainId = safeSet(setChainId);
    const _setIsConnecting = safeSet(setIsConnecting);
    const _setConnectionError = safeSet(setConnectionError);
    const _setStatus = safeSet(setStatus);

    // ======= Core updater =======
    const updateWalletState = useCallback(
        async (addr, prov) => {
            if (!prov) {
                _setWallet(null);
                _setSigner(null);
                _setChainId(null);
                _setProvider(null);
                return;
            }

            try {
                const net = await prov.getNetwork();
                const signer = addr ? await prov.getSigner() : null;

                _setProvider(prov);
                _setSigner(signer);
                _setWallet(addr ? ethers.getAddress(addr) : null); // checksum normalize
                _setChainId(net?.chainId ? Number(net.chainId) : null);
            } catch (e) {
                console.error('[Wallet] updateWalletState failed:', e);
                _setWallet(null);
                _setSigner(null);
                // Keep provider for read-only usage
                const ro = await makeReadonlyProvider().catch(() => null);
                _setProvider(ro);
            }
        },
        [_setWallet, _setSigner, _setChainId, _setProvider]
    );

    // ======= Switch / ensure network =======
    const switchNetwork = useCallback(
        async (target = TARGET) => {
            if (!window.ethereum || !target?.hex) return false;
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: target.hex }]
                });
                return true;
            } catch (err) {
                // Unknown chain → try add
                if (err?.code === 4902 && ADD_CHAIN_PARAMS) {
                    try {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [ADD_CHAIN_PARAMS]
                        });
                        return true;
                    } catch (err2) {
                        console.warn('[Wallet] addEthereumChain failed:', err2);
                        return false;
                    }
                }
                console.warn('[Wallet] switchEthereumChain failed:', err);
                return false;
            }
        },
        []
    );

    const ensureCorrectNetwork = useCallback(
        async (force = false) => {
            if (!TARGET.num) return true; // no target set → accept any
            try {
                const cur = provider || (await makeBrowserProvider());
                if (!cur) return true;

                const net = await cur.getNetwork();
                const currentId = Number(net.chainId);
                if (currentId === TARGET.num) return true;

                if (!force) return false;
                const ok = await switchNetwork(TARGET);
                return ok;
            } catch (e) {
                console.warn('[Wallet] ensureCorrectNetwork error:', e);
                return false;
            }
        },
        [provider, switchNetwork]
    );

    // ======= Initialisation =======
    useEffect(() => {
        mountedRef.current = true;
        (async () => {
            _setStatus('initialising');
            try {
                // Always have a RO provider ready
                const ro = await makeReadonlyProvider().catch(() => null);
                _setProvider(ro);

                // Eager restore?
                const wasConnected = localStorage.getItem('walletConnected') === 'true';
                if (wasConnected && window.ethereum) {
                    try {
                        const bp = await makeBrowserProvider();
                        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                        const addr = accounts?.[0];
                        if (addr) {
                            await updateWalletState(addr, bp);
                            await ensureCorrectNetwork(false); // don’t force-switch on load
                        }
                    } catch (e) {
                        console.warn('[Wallet] eager connect failed:', e);
                        localStorage.removeItem('walletConnected');
                    }
                }
                _setStatus('ready');
            } catch (e) {
                console.error('[Wallet] init failed:', e);
                _setConnectionError(e.message || String(e));
                _setStatus('error');
            }
        })();

        return () => { mountedRef.current = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ======= Event listeners (EIP-1193) =======
    useEffect(() => {
        if (!window.ethereum || listenersBoundRef.current) return;

        const onAccountsChanged = async (accounts) => {
            try {
                if (!accounts || accounts.length === 0) {
                    _setWallet(null);
                    _setSigner(null);
                    localStorage.removeItem('walletConnected');
                    return;
                }
                const bp = (provider instanceof ethers.BrowserProvider ? provider : await makeBrowserProvider()) || provider;
                await updateWalletState(accounts[0], bp);
                localStorage.setItem('walletConnected', 'true');
            } catch (e) {
                console.warn('[Wallet] accountsChanged handler error:', e);
            }
        };

        const onChainChanged = async (chainIdHex) => {
            try {
                const chainNum = parseInt(chainIdHex, 16);
                _setChainId(chainNum);
                // Refresh provider/signer for ethers v6
                if (wallet) {
                    const bp = await makeBrowserProvider();
                    await updateWalletState(wallet, bp);
                }
            } catch (e) {
                console.warn('[Wallet] chainChanged handler error:', e);
            }
        };

        const onConnect = (info) => {
            // Usually followed by accountsChanged; keep it lightweight.
            console.log('[Wallet] connect:', info);
        };

        const onDisconnect = (err) => {
            console.log('[Wallet] disconnect:', err);
            _setWallet(null);
            _setSigner(null);
            localStorage.removeItem('walletConnected');
        };

        window.ethereum.on('accountsChanged', onAccountsChanged);
        window.ethereum.on('chainChanged', onChainChanged);
        window.ethereum.on('connect', onConnect);
        window.ethereum.on('disconnect', onDisconnect);
        listenersBoundRef.current = true;

        return () => {
            if (window.ethereum?.removeListener) {
                window.ethereum.removeListener('accountsChanged', onAccountsChanged);
                window.ethereum.removeListener('chainChanged', onChainChanged);
                window.ethereum.removeListener('connect', onConnect);
                window.ethereum.removeListener('disconnect', onDisconnect);
            }
            listenersBoundRef.current = false;
        };
    }, [provider, wallet, updateWalletState, _setChainId, _setSigner, _setWallet]);

    // ======= Public API =======
    const connect = useCallback(
        async ({ forceSwitchToTarget = !!TARGET.num } = {}) => {
            // If PremiumWallet is available and not connected, use its connect method
            if (premiumWallet && !premiumWallet.isConnected) {
                try {
                    _setIsConnecting(true);
                    _setConnectionError(null);
                    
                    // Use PremiumWallet's AppKit modal to connect
                    const { open } = await import('@reown/appkit/react');
                    open();
                    return true; // The modal will handle the connection
                } catch (e) {
                    console.error('[Wallet] PremiumWallet connect error:', e);
                    _setConnectionError(e.message || String(e));
                    return false;
                } finally {
                    _setIsConnecting(false);
                }
            }
            
            // Fallback to traditional wallet connection
            if (!window.ethereum) {
                _setConnectionError('No injected wallet found. Please install MetaMask or a compatible wallet.');
                return false;
            }
            try {
                _setIsConnecting(true);
                _setConnectionError(null);

                // Optionally ask the wallet to switch chains before requesting accounts
                if (forceSwitchToTarget && TARGET.hex) {
                    const ok = await ensureCorrectNetwork(true);
                    if (!ok) throw new Error('Please approve the network switch in your wallet.');
                }

                const bp = await makeBrowserProvider();
                if (!bp) throw new Error('Failed to initialise wallet provider.');

                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                if (!accounts || accounts.length === 0) throw new Error('No account returned by wallet.');

                await updateWalletState(accounts[0], bp);
                localStorage.setItem('walletConnected', 'true');
                return true;
            } catch (e) {
                console.error('[Wallet] connect error:', e);
                _setConnectionError(e.message || String(e));
                return false;
            } finally {
                _setIsConnecting(false);
            }
        },
        [premiumWallet, ensureCorrectNetwork, updateWalletState, _setConnectionError, _setIsConnecting]
    );

    const disconnect = useCallback(async () => {
        // If PremiumWallet is connected, use its disconnect method
        if (premiumWallet?.isConnected) {
            try {
                await premiumWallet.disconnect();
            } catch (e) {
                console.error('[Wallet] PremiumWallet disconnect error:', e);
            }
        }
        
        // Also clear legacy state
        _setWallet(null);
        _setSigner(null);
        localStorage.removeItem('walletConnected');
        // keep read-only provider alive
    }, [premiumWallet]);

    const signMessage = useCallback(
        async (message) => {
            if (!signer) throw new Error('Wallet not connected');
            return await signer.signMessage(message);
        },
        [signer]
    );

    const signTypedData = useCallback(
        async (domain, types, value) => {
            if (!signer) throw new Error('Wallet not connected');
            // ethers v6: signTypedData(domain, types, value)
            return await signer.signTypedData(domain, types, value);
        },
        [signer]
    );

    const sendTransaction = useCallback(
        async (tx) => {
            if (!signer) throw new Error('Wallet not connected');
            const resp = await signer.sendTransaction(tx);
            return await resp.wait();
        },
        [signer]
    );

    const getBalance = useCallback(
        async (address) => {
            const prov = provider || (await makeReadonlyProvider());
            const bal = await prov.getBalance(address);
            return ethers.formatEther(bal);
        },
        [provider]
    );

    const watchAsset = useCallback(
        async ({ address, symbol, decimals = 18, image } = {}) => {
            if (!window.ethereum) return false;
            try {
                const res = await window.ethereum.request({
                    method: 'wallet_watchAsset',
                    params: {
                        type: 'ERC20',
                        options: { address, symbol, decimals, image }
                    }
                });
                return !!res;
            } catch (e) {
                console.warn('[Wallet] watchAsset failed:', e);
                return false;
            }
        },
        []
    );

    const isConnected = !!wallet && !!signer;
    // The wallet must match the marketplace selected in ChainSwitcher.
    // Merely being on either supported chain is not enough: the active
    // marketplace address, RPC and explorer all belong to TARGET.num.
    const isCorrectNetwork = TARGET.num ? chainId === TARGET.num : true;

    return (
        <WalletContext.Provider
            value={{
                wallet,
                provider,
                signer,
                chainId,
                isConnected,
                isCorrectNetwork,
                status,
                connectionError,
                isConnecting,

                connect,
                disconnect,
                switchNetwork,
                ensureCorrectNetwork,

                signMessage,
                signTypedData,
                sendTransaction,
                getBalance,
                watchAsset
            }}
        >
            {children}
        </WalletContext.Provider>
    );
}

export function useWallet() {
    return useContext(WalletContext);
}
