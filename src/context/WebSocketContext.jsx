import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { showToast } from '../components/ui/toast';

const WebSocketContext = createContext();

// WebSocket connection manager for Vercel-compatible real-time features
export function WebSocketProvider({ children }) {
    const [isConnected, setIsConnected] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected, connecting, connected, error
    const [lastMessage, setLastMessage] = useState(null);
    const [subscribers, setSubscribers] = useState(new Map());
    
    const wsRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);
    const maxReconnectAttempts = 5;
    const reconnectDelay = 1000; // Start with 1 second

    // For demo/development, we'll simulate WebSocket with polling and localStorage
    // In production, this would connect to a real WebSocket server
    const [isSimulated, setIsSimulated] = useState(true);
    const pollingIntervalRef = useRef(null);

    const connect = useCallback(() => {
        if (isSimulated) {
            // Simulate WebSocket connection for development
            setConnectionStatus('connecting');
            
            setTimeout(() => {
                setIsConnected(true);
                setConnectionStatus('connected');
                
                // Start polling for simulated real-time updates
                pollingIntervalRef.current = setInterval(() => {
                    simulateRealTimeUpdate();
                }, 5000); // Poll every 5 seconds
                
                showToast('✅ Real-time connection established', 'success');
            }, 1000);
            
            return;
        }

        // Real WebSocket implementation (for production)
        setConnectionStatus('connecting');
        
        try {
            // In production, this would be your WebSocket endpoint
            // For Vercel, you might use Socket.IO or a third-party service like Pusher
            const wsUrl = process.env.VITE_WEBSOCKET_URL || 'wss://your-websocket-endpoint.com';
            wsRef.current = new WebSocket(wsUrl);
            
            wsRef.current.onopen = () => {
                setIsConnected(true);
                setConnectionStatus('connected');
                reconnectAttemptsRef.current = 0;
                
                showToast('✅ Real-time connection established', 'success');
            };
            
            wsRef.current.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleMessage(data);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };
            
            wsRef.current.onclose = () => {
                setIsConnected(false);
                setConnectionStatus('disconnected');
                
                // Attempt to reconnect
                if (reconnectAttemptsRef.current < maxReconnectAttempts) {
                    const delay = reconnectDelay * Math.pow(2, reconnectAttemptsRef.current);
                    reconnectTimeoutRef.current = setTimeout(() => {
                        reconnectAttemptsRef.current += 1;
                        connect();
                    }, delay);
                } else {
                    showToast('❌ Connection lost. Please refresh to reconnect.', 'error');
                }
            };
            
            wsRef.current.onerror = (error) => {
                console.error('WebSocket error:', error);
                setConnectionStatus('error');
                showToast('⚠️ Connection error. Retrying...', 'warning');
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            setConnectionStatus('error');
        }
    }, [isSimulated]);

    const disconnect = useCallback(() => {
        if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
        }
        
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        
        setIsConnected(false);
        setConnectionStatus('disconnected');
    }, []);

    const sendMessage = useCallback((message) => {
        if (isSimulated) {
            // In simulation mode, just echo the message back after a delay
            setTimeout(() => {
                handleMessage({
                    type: 'echo',
                    data: message,
                    timestamp: Date.now()
                });
            }, 500);
            return;
        }
        
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(message));
        } else {
            console.warn('WebSocket is not connected');
        }
    }, [isSimulated]);

    const subscribe = useCallback((eventType, callback) => {
        const id = Math.random().toString(36).substr(2, 9);
        
        setSubscribers(prev => {
            const newSubscribers = new Map(prev);
            if (!newSubscribers.has(eventType)) {
                newSubscribers.set(eventType, new Map());
            }
            newSubscribers.get(eventType).set(id, callback);
            return newSubscribers;
        });
        
        // Return unsubscribe function
        return () => {
            setSubscribers(prev => {
                const newSubscribers = new Map(prev);
                if (newSubscribers.has(eventType)) {
                    newSubscribers.get(eventType).delete(id);
                    if (newSubscribers.get(eventType).size === 0) {
                        newSubscribers.delete(eventType);
                    }
                }
                return newSubscribers;
            });
        };
    }, []);

    const handleMessage = useCallback((data) => {
        setLastMessage(data);
        
        // Notify subscribers
        if (subscribers.has(data.type)) {
            subscribers.get(data.type).forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error('Error in WebSocket subscriber callback:', error);
                }
            });
        }
    }, [subscribers]);

    // Simulate real-time updates for development
    const simulateRealTimeUpdate = useCallback(() => {
        const updateTypes = [
            'listing.new',
            'listing.price_change',
            'auction.new_bid',
            'user.activity'
        ];
        
        const randomType = updateTypes[Math.floor(Math.random() * updateTypes.length)];
        
        const mockData = {
            'listing.new': {
                type: 'listing.new',
                data: {
                    id: Math.random().toString(36).substr(2, 9),
                    title: 'New NFT Listed!',
                    price: '1.5 USDC',
                    collection: 'Cyber Punks'
                },
                timestamp: Date.now()
            },
            'listing.price_change': {
                type: 'listing.price_change',
                data: {
                    id: '123',
                    oldPrice: '2.0 USDC',
                    newPrice: '1.8 USDC',
                    change: -10
                },
                timestamp: Date.now()
            },
            'auction.new_bid': {
                type: 'auction.new_bid',
                data: {
                    auctionId: '456',
                    bidAmount: '3.2 VTRU',
                    bidder: '0x1234...5678'
                },
                timestamp: Date.now()
            },
            'user.activity': {
                type: 'user.activity',
                data: {
                    action: 'purchase',
                    user: '0xabcd...efgh',
                    item: 'Neon Runner #1337'
                },
                timestamp: Date.now()
            }
        };
        
        handleMessage(mockData[randomType]);
    }, [handleMessage]);

    // Initialize connection
    useEffect(() => {
        connect();
        
        return () => {
            disconnect();
        };
    }, [connect, disconnect]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            disconnect();
        };
    }, [disconnect]);

    const value = {
        isConnected,
        connectionStatus,
        lastMessage,
        sendMessage,
        subscribe,
        connect,
        disconnect,
        isSimulated
    };

    return (
        <WebSocketContext.Provider value={value}>
            {children}
        </WebSocketContext.Provider>
    );
}

export function useWebSocket() {
    const context = useContext(WebSocketContext);
    if (!context) {
        throw new Error('useWebSocket must be used within a WebSocketProvider');
    }
    return context;
}

// Custom hooks for specific real-time features
export function useRealTimeListings() {
    const { subscribe, isConnected } = useWebSocket();
    const [listings, setListings] = useState([]);
    const [newListingCount, setNewListingCount] = useState(0);

    useEffect(() => {
        const unsubscribeNew = subscribe('listing.new', (data) => {
            setListings(prev => [data.data, ...prev.slice(0, 9)]); // Keep last 10
            setNewListingCount(prev => prev + 1);
        });

        const unsubscribePrice = subscribe('listing.price_change', (data) => {
            setListings(prev => prev.map(listing => 
                listing.id === data.data.id 
                    ? { ...listing, price: data.data.newPrice }
                    : listing
            ));
        });

        return () => {
            unsubscribeNew();
            unsubscribePrice();
        };
    }, [subscribe]);

    return {
        listings,
        newListingCount,
        isConnected,
        clearNewCount: () => setNewListingCount(0)
    };
}

export function useRealTimeAuctions() {
    const { subscribe, isConnected } = useWebSocket();
    const [auctions, setAuctions] = useState([]);
    const [newBidCount, setNewBidCount] = useState(0);

    useEffect(() => {
        const unsubscribe = subscribe('auction.new_bid', (data) => {
            setAuctions(prev => {
                const existing = prev.find(a => a.id === data.data.auctionId);
                if (existing) {
                    return prev.map(auction =>
                        auction.id === data.data.auctionId
                            ? { ...auction, currentBid: data.data.bidAmount, lastBidder: data.data.bidder }
                            : auction
                    );
                }
                return prev;
            });
            setNewBidCount(prev => prev + 1);
        });

        return unsubscribe;
    }, [subscribe]);

    return {
        auctions,
        newBidCount,
        isConnected,
        clearNewCount: () => setNewBidCount(0)
    };
}

export function useRealTimeActivity() {
    const { subscribe, isConnected } = useWebSocket();
    const [activities, setActivities] = useState([]);

    useEffect(() => {
        const unsubscribe = subscribe('user.activity', (data) => {
            setActivities(prev => [data.data, ...prev.slice(0, 19)]); // Keep last 20
        });

        return unsubscribe;
    }, [subscribe]);

    return {
        activities,
        isConnected
    };
}