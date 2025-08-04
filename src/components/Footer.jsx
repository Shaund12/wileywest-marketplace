import React from 'react';
import { Link } from 'react-router-dom';
import logo from '../assets/logo.svg';

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-container">
        <div className="footer-top">
          <div className="footer-logo">
            <img src={logo} alt="WileyW€$T" />
            <h3>WileyW€$T NFT Marketplace</h3>
            <p>Trade in the neon shadows. Own the future.</p>
          </div>
          
          <div className="footer-links">
            <div className="footer-column">
              <h4>Marketplace</h4>
              <Link to="/marketplace">All NFTs</Link>
              <Link to="/hot-listings">Hot Listings</Link>
              <Link to="/sell">Sell NFT</Link>
            </div>
            
            <div className="footer-column">
              <h4>Account</h4>
              <Link to="/profile">Profile</Link>
              <Link to="/profile?tab=collection">My Collection</Link>
              <Link to="/profile?tab=activity">Activity</Link>
            </div>
            
            <div className="footer-column">
              <h4>Company</h4>
              <Link to="/terms">Terms of Service</Link>
              <Link to="/privacy">Privacy Policy</Link>
            </div>
          </div>
        </div>
        
        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} WileyW€$T NFT Marketplace. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

export default Footer;