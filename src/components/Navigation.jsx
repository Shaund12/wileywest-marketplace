import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import logo from '../assets/blockdust-logo.png';

function Navigation() {
  const { wallet, connect, disconnect } = useWallet();
  const location = useLocation();

  return (
    <nav className="navigation">
      <div className="nav-container">
        <div className="nav-logo">
          <Link to="/">

            <img src={logo} alt="BlockDust" />
            <span>BlockDust</span>

          </Link>
        </div>
        
        <div className="nav-links">
          <Link to="/marketplace" className={location.pathname === '/marketplace' ? 'active' : ''}>
            Marketplace
          </Link>
          <Link to="/hot-listings" className={location.pathname === '/hot-listings' ? 'active' : ''}>
            Hot Listings
          </Link>
          <Link to="/sell" className={location.pathname === '/sell' ? 'active' : ''}>
            Sell NFT
          </Link>
        </div>
        
        <div className="nav-actions">
          {wallet ? (
            <div className="wallet-info">
              <Link to="/profile" className="profile-button">
                My Profile
              </Link>
              <div className="wallet-address">
                {wallet.slice(0, 6)}...{wallet.slice(-4)}
              </div>
              <button className="disconnect-button" onClick={disconnect}>
                Disconnect
              </button>
            </div>
          ) : (
            <button className="connect-button" onClick={connect}>
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navigation;