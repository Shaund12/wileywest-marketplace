import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { appKit } from '../config/appkit';

const ThemeContext = createContext();

const STORAGE_KEY = 'theme';

// Resolve the initial theme: saved preference → OS preference → dark (app default).
const getInitialTheme = () => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'light' || saved === 'dark') return saved;
        if (typeof window !== 'undefined' && window.matchMedia) {
            return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }
    } catch {
        // localStorage / matchMedia unavailable → fall through to default
    }
    return 'dark';
};

export const ThemeProvider = ({ children }) => {
    const [theme, setTheme] = useState(getInitialTheme);

    // Apply the theme to <html data-theme> and persist it.
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        // Keep Tailwind's class-based dark mode in sync with our data-theme system.
        document.documentElement.classList.toggle('dark', theme === 'dark');
        appKit?.setThemeMode?.(theme);
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            // ignore persistence errors (private mode, etc.)
        }
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
    }, []);

    const value = { theme, setTheme, toggleTheme, isDark: theme === 'dark' };

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
