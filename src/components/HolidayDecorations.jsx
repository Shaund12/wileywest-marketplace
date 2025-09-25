import React from 'react';
import { useHolidayTheme } from '../context/HolidayThemeContext';

const HolidayDecorations = () => {
    const { holidayTheme, getHolidayConfig } = useHolidayTheme();
    const config = getHolidayConfig();

    if (holidayTheme === 'default') {
        return null;
    }

    const renderDecorations = () => {
        switch (holidayTheme) {
            case 'halloween':
                return (
                    <div className="holiday-decorations">
                        <div className="falling-leaves"></div>
                        <div className="pumpkin-decoration">🎃</div>
                        <div className="pumpkin-decoration">👻</div>
                        <div className="pumpkin-decoration">🍭</div>
                    </div>
                );
            
            case 'thanksgiving':
                return (
                    <div className="holiday-decorations">
                        <div className="autumn-leaves"></div>
                        <div className="turkey-decoration">🦃</div>
                        <div className="turkey-decoration">🌽</div>
                        <div className="turkey-decoration">🍂</div>
                    </div>
                );
            
            case 'christmas':
                return (
                    <div className="holiday-decorations">
                        <div className="christmas-lights"></div>
                        <div className="snow"></div>
                        <div className="christmas-decoration">🎄</div>
                        <div className="christmas-decoration">🎁</div>
                        <div className="christmas-decoration">🔔</div>
                        <div className="christmas-decoration">🎅</div>
                    </div>
                );
            
            default:
                return null;
        }
    };

    return renderDecorations();
};

export default HolidayDecorations;