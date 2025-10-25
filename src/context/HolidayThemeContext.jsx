import React, { createContext, useContext, useState, useEffect } from 'react';

const HolidayThemeContext = createContext();

// Holiday theme detection based on dates
export const getActiveHolidayTheme = () => {
    const now = new Date();
    const month = now.getMonth() + 1; // JavaScript months are 0-indexed
    const day = now.getDate();

    // Halloween theme: October (all month leading up to Oct 31)
    if (month === 10) {
        return 'halloween';
    }

    // Thanksgiving theme: November (focus on Thanksgiving week - 3rd-4th Thursday)
    if (month === 11) {
        return 'thanksgiving';
    }

    // Christmas theme: December (all month leading up to Dec 25)
    if (month === 12) {
        return 'christmas';
    }

    return 'default';
};

export const HolidayThemeProvider = ({ children }) => {
    // Get manual override from localStorage, or auto-detect
    const [holidayTheme, setHolidayTheme] = useState(() => {
        const manual = localStorage.getItem('holiday-theme-manual');
        if (manual && manual !== 'auto') {
            return manual;
        }
        return getActiveHolidayTheme();
    });

    const [isManualOverride, setIsManualOverride] = useState(() => {
        const manual = localStorage.getItem('holiday-theme-manual');
        return manual && manual !== 'auto';
    });

    // Auto-update theme when not manually overridden
    useEffect(() => {
        if (!isManualOverride) {
            const autoTheme = getActiveHolidayTheme();
            if (autoTheme !== holidayTheme) {
                setHolidayTheme(autoTheme);
            }
        }
    }, [holidayTheme, isManualOverride]);

    // Update document attributes for CSS
    useEffect(() => {
        document.documentElement.dataset.holidayTheme = holidayTheme;
    }, [holidayTheme]);

    const setManualHolidayTheme = (theme) => {
        if (theme === 'auto') {
            // Reset to auto mode
            setIsManualOverride(false);
            setHolidayTheme(getActiveHolidayTheme());
            localStorage.setItem('holiday-theme-manual', 'auto');
        } else {
            // Set manual override
            setIsManualOverride(true);
            setHolidayTheme(theme);
            localStorage.setItem('holiday-theme-manual', theme);
        }
    };

    const getHolidayConfig = () => {
        const configs = {
            default: {
                name: 'Default',
                colors: {
                    primary: 'var(--neon-cyan)',
                    secondary: 'var(--neon-purple)',
                    accent: 'var(--neon-pink)'
                },
                decorations: []
            },
            halloween: {
                name: 'Halloween',
                colors: {
                    primary: '#ff6600', // Orange
                    secondary: '#8B4513', // Brown
                    accent: '#4B0082'    // Dark purple
                },
                decorations: ['pumpkins', 'falling-leaves', 'spooky-elements', 'candy']
            },
            thanksgiving: {
                name: 'Thanksgiving',
                colors: {
                    primary: '#D2691E', // Chocolate/brown
                    secondary: '#DAA520', // Goldenrod
                    accent: '#8B4513'    // Saddle brown
                },
                decorations: ['turkeys', 'autumn-leaves', 'harvest-imagery']
            },
            christmas: {
                name: 'Christmas',
                colors: {
                    primary: '#228B22', // Forest green
                    secondary: '#DC143C', // Crimson red
                    accent: '#FFD700'    // Gold
                },
                decorations: ['christmas-lights', 'candy-canes', 'wreaths', 'snow', 'presents']
            }
        };
        return configs[holidayTheme] || configs.default;
    };

    const value = {
        holidayTheme,
        isManualOverride,
        setManualHolidayTheme,
        getHolidayConfig,
        availableThemes: ['auto', 'default', 'halloween', 'thanksgiving', 'christmas']
    };

    return (
        <HolidayThemeContext.Provider value={value}>
            {children}
        </HolidayThemeContext.Provider>
    );
};

export const useHolidayTheme = () => {
    const context = useContext(HolidayThemeContext);
    if (!context) {
        throw new Error('useHolidayTheme must be used within a HolidayThemeProvider');
    }
    return context;
};