import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, TrendingUp, Gavel, Activity, Zap } from 'lucide-react';
import { useRealTimeListings, useRealTimeAuctions, useRealTimeActivity } from '../context/WebSocketContext';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

const RealTimeNotifications = ({ className }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [notifications, setNotifications] = useState([]);
    
    const { listings, newListingCount, clearNewCount: clearListingCount } = useRealTimeListings();
    const { newBidCount, clearNewCount: clearBidCount } = useRealTimeAuctions();
    const { activities } = useRealTimeActivity();

    // Combine all real-time updates into notifications
    useEffect(() => {
        const newNotifications = [];
        
        // Add new listings
        listings.slice(0, 5).forEach(listing => {
            newNotifications.push({
                id: `listing-${listing.id}`,
                type: 'listing',
                title: 'New NFT Listed',
                message: `${listing.title} - ${listing.price}`,
                icon: TrendingUp,
                timestamp: Date.now(),
                color: 'neon-cyan'
            });
        });
        
        // Add recent activities
        activities.slice(0, 3).forEach((activity, index) => {
            newNotifications.push({
                id: `activity-${index}`,
                type: 'activity',
                title: 'Market Activity',
                message: `${activity.action} by ${activity.user}`,
                icon: Activity,
                timestamp: activity.timestamp || Date.now(),
                color: 'neon-green'
            });
        });
        
        setNotifications(newNotifications.slice(0, 8)); // Keep only 8 most recent
    }, [listings, activities]);

    const totalNotifications = newListingCount + newBidCount;
    
    const toggleExpanded = () => {
        setIsExpanded(!isExpanded);
        if (!isExpanded) {
            // Clear counts when opening
            clearListingCount();
            clearBidCount();
        }
    };

    const getNotificationIcon = (type) => {
        switch (type) {
            case 'listing': return TrendingUp;
            case 'auction': return Gavel;
            case 'activity': return Activity;
            default: return Zap;
        }
    };

    return (
        <div className={cn('fixed bottom-4 right-4 z-50', className)}>
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.9 }}
                        className="mb-4 w-80 max-h-96 overflow-hidden"
                    >
                        <div className="bg-card/95 backdrop-blur-lg border border-border/50 rounded-lg shadow-xl">
                            <div className="flex items-center justify-between p-4 border-b border-border/50">
                                <div className="flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-neon-cyan animate-pulse" />
                                    <h3 className="font-medium text-sm">Live Updates</h3>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setIsExpanded(false)}
                                    className="h-6 w-6 p-0"
                                >
                                    <X className="w-3 h-3" />
                                </Button>
                            </div>
                            
                            <div className="max-h-64 overflow-y-auto">
                                {notifications.length > 0 ? (
                                    <div className="p-2 space-y-2">
                                        {notifications.map((notification, index) => {
                                            const IconComponent = getNotificationIcon(notification.type);
                                            return (
                                                <motion.div
                                                    key={notification.id}
                                                    initial={{ opacity: 0, x: 20 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    transition={{ delay: index * 0.05 }}
                                                    className="flex items-start gap-3 p-3 rounded-lg bg-background/50 hover:bg-background/70 transition-colors"
                                                >
                                                    <div className={`flex-shrink-0 w-8 h-8 rounded-full bg-${notification.color}/10 border border-${notification.color}/30 flex items-center justify-center`}>
                                                        <IconComponent className={`w-4 h-4 text-${notification.color}`} />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-foreground">
                                                            {notification.title}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground truncate">
                                                            {notification.message}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground mt-1">
                                                            {new Date(notification.timestamp).toLocaleTimeString()}
                                                        </p>
                                                    </div>
                                                </motion.div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="p-8 text-center">
                                        <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                                        <p className="text-sm text-muted-foreground">
                                            No recent activity
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
            
            {/* Notification Button */}
            <motion.div
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
            >
                <Button
                    onClick={toggleExpanded}
                    variant="cyber"
                    size="icon"
                    className="relative w-12 h-12 rounded-full shadow-lg hover:shadow-xl transition-all duration-300 group"
                >
                    <motion.div
                        animate={{ rotate: isExpanded ? 180 : 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <Zap className="w-5 h-5" />
                    </motion.div>
                    
                    {/* Notification Badge */}
                    <AnimatePresence>
                        {totalNotifications > 0 && (
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                exit={{ scale: 0 }}
                                className="absolute -top-1 -right-1"
                            >
                                <Badge
                                    variant="destructive"
                                    className="h-5 w-5 p-0 flex items-center justify-center text-xs font-bold rounded-full animate-pulse"
                                >
                                    {totalNotifications > 99 ? '99+' : totalNotifications}
                                </Badge>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    
                    {/* Pulse Ring Effect */}
                    {totalNotifications > 0 && (
                        <div className="absolute inset-0 rounded-full border-2 border-neon-cyan animate-ping opacity-30" />
                    )}
                </Button>
            </motion.div>
        </div>
    );
};

export default RealTimeNotifications;