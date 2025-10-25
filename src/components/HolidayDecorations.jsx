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
                        {/* Multiple falling elements */}
                        <div className="falling-halloween-items">
                            <div className="falling-item">🎃</div>
                            <div className="falling-item">👻</div>
                            <div className="falling-item">🍭</div>
                            <div className="falling-item">🦇</div>
                            <div className="falling-item">🕸️</div>
                            <div className="falling-item">💀</div>
                            <div className="falling-item">🕷️</div>
                            <div className="falling-item">🍂</div>
                            <div className="falling-item">🎭</div>
                            <div className="falling-item">⚡</div>
                        </div>
                        {/* Static corner decorations */}
                        <div className="corner-decorations halloween">
                            <div className="corner top-left">🎃👻</div>
                            <div className="corner top-right">🦇🕸️</div>
                            <div className="corner bottom-left">💀🕷️</div>
                            <div className="corner bottom-right">🍭🎭</div>
                        </div>
                        {/* Spooky lights border */}
                        <div className="spooky-lights-border"></div>
                    </div>
                );
            
            case 'thanksgiving':
                return (
                    <div className="holiday-decorations">
                        {/* Multiple falling elements */}
                        <div className="falling-thanksgiving-items">
                            <div className="falling-item">🦃</div>
                            <div className="falling-item">🍂</div>
                            <div className="falling-item">🌽</div>
                            <div className="falling-item">🥧</div>
                            <div className="falling-item">🍁</div>     
                            <div className="falling-item">🌾</div>
                            <div className="falling-item">🎯</div>
                            <div className="falling-item">🧡</div>
                            <div className="falling-item">🥕</div>
                            <div className="falling-item">🍄</div>
                        </div>
                        {/* Static corner decorations */}
                        <div className="corner-decorations thanksgiving">
                            <div className="corner top-left">🦃🍂</div>
                            <div className="corner top-right">🌽🥧</div>
                            <div className="corner bottom-left">🍁🌾</div>
                            <div className="corner bottom-right">🥕🍄</div>
                        </div>
                        {/* Harvest wreath border */}
                        <div className="harvest-wreath-border"></div>
                    </div>
                );
            
            case 'christmas':
                return (
                    <div className="holiday-decorations">
                        {/* Multiple falling elements */}
                        <div className="falling-christmas-items">
                            <div className="falling-item">❄️</div>
                            <div className="falling-item">🎁</div>
                            <div className="falling-item">⭐</div>
                            <div className="falling-item">🔔</div>
                            <div className="falling-item">🎄</div>
                            <div className="falling-item">🎅</div>
                            <div className="falling-item">🤶</div>
                            <div className="falling-item">🦌</div>
                            <div className="falling-item">⛄</div>
                            <div className="falling-item">🕯️</div>
                            <div className="falling-item">🎂</div>
                            <div className="falling-item">🧑‍🎄</div>
                        </div>
                        {/* Static corner decorations */}
                        <div className="corner-decorations christmas">
                            <div className="corner top-left">🎄⭐</div>
                            <div className="corner top-right">🎁🔔</div>
                            <div className="corner bottom-left">🎅🤶</div>
                            <div className="corner bottom-right">⛄🦌</div>
                        </div>
                        {/* Christmas lights border */}
                        <div className="christmas-lights-border"></div>
                        {/* Holly wreaths */}
                        <div className="wreaths">
                            <div className="wreath top">🎄🔴🟢🟡🔴🟢🎄</div>
                            <div className="wreath bottom">🎄🟡🔴🟢🟡🔴🎄</div>
                        </div>
                    </div>
                );
            
            default:
                return null;
        }
    };

    return renderDecorations();
};

export default HolidayDecorations;