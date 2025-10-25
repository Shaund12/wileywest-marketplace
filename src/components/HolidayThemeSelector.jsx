import React from 'react';
import { useHolidayTheme } from '../context/HolidayThemeContext';

const HolidayThemeSelector = () => {
    const { holidayTheme, isManualOverride, setManualHolidayTheme, availableThemes } = useHolidayTheme();

    const themeLabels = {
        auto: '🤖 Auto',
        default: '🌟 Default',
        halloween: '🎃 Halloween',
        thanksgiving: '🦃 Thanksgiving',
        christmas: '🎄 Christmas'
    };

    const handleThemeChange = (theme) => {
        setManualHolidayTheme(theme);
    };

    return (
        <div className="holiday-theme-selector">
            {availableThemes.map((theme) => (
                <button
                    key={theme}
                    className={`holiday-theme-btn ${
                        (theme === 'auto' && !isManualOverride) || 
                        (theme === holidayTheme && isManualOverride) 
                            ? 'active' 
                            : ''
                    }`}
                    data-theme={theme}
                    onClick={() => handleThemeChange(theme)}
                    title={
                        theme === 'auto' 
                            ? 'Automatically activate themes based on current date'
                            : `Switch to ${themeLabels[theme]} theme`
                    }
                >
                    {themeLabels[theme]}
                </button>
            ))}
        </div>
    );
};

export default HolidayThemeSelector;