# WileyW€$T NFT Marketplace

A cyberpunk-themed NFT marketplace built on the Vitruveo blockchain. Trade digital assets in the neon shadows of the future.

![WileyW€$T Marketplace](https://github.com/user-attachments/assets/44294fc7-73ec-45e5-916e-5e684ac3d25a)

## 🚀 Features

### Core Functionality
- **NFT Trading**: Buy and sell ERC-721 and ERC-1155 NFTs
- **Multi-Token Support**: Support for VTRU, wVTRU, USDC, and custom tokens
- **Real-time Pricing**: Live price feeds from Uniswap v3 and CoinGecko API
- **Wallet Integration**: MetaMask and other Web3 wallet support
- **Smart Contract Integration**: Direct interaction with Vitruveo blockchain

### Advanced Features
- **Price Service**: Real-time token price fetching with intelligent fallbacks
- **Error Boundaries**: Comprehensive error handling and recovery
- **Responsive Design**: Optimized for desktop, tablet, and mobile
- **Loading States**: Smooth user experience with proper loading indicators
- **Caching**: Smart price caching to reduce API calls and improve performance

### Security & Reliability
- **Input Validation**: Robust validation for all user inputs
- **Error Handling**: Graceful error handling with user-friendly messages
- **Network Resilience**: Automatic retry logic for failed network requests
- **Transaction Safety**: Comprehensive transaction validation and confirmations

## 🛠️ Tech Stack

- **Frontend**: React 18.2, React Router 7.7
- **Blockchain**: ethers.js 6.9, Vitruveo RPC
- **Build Tool**: Vite 6.0
- **Styling**: Custom CSS with CSS Variables
- **Backend**: Supabase (database and storage)
- **Price Feeds**: Uniswap v3, CoinGecko API

## 📦 Installation

### Prerequisites
- Node.js 16+ and npm
- MetaMask or compatible Web3 wallet
- Access to Vitruveo network

### Setup
1. **Clone the repository**
   ```bash
   git clone https://github.com/Shaund12/wileywest-marketplace.git
   cd wileywest-marketplace
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory:
   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   VITE_RPC_URL=https://rpc.vitruveo.xyz
   VITE_MARKETPLACE_ADDRESS=your_marketplace_contract_address
   ```

4. **Start Development Server**
   ```bash
   npm run dev
   ```

5. **Build for Production**
   ```bash
   npm run build
   ```

## 🔧 Configuration

### Network Configuration
The marketplace is configured for the Vitruveo blockchain by default. To change networks:

1. Update `VITE_RPC_URL` in your `.env` file
2. Update contract addresses for the target network
3. Ensure your wallet is connected to the correct network

### Smart Contract Integration
The marketplace interacts with these contract types:
- **Marketplace Contract**: Core trading functionality
- **ERC-721 NFTs**: Unique digital assets
- **ERC-1155 NFTs**: Semi-fungible tokens
- **ERC-20 Tokens**: Payment tokens (VTRU, wVTRU, USDC)

## 💡 Usage

### For Buyers
1. **Connect Wallet**: Click "Connect Wallet" and approve MetaMask connection
2. **Browse NFTs**: Navigate to Marketplace or Hot Listings
3. **Purchase**: Click on an NFT and complete the purchase transaction

### For Sellers
1. **Connect Wallet**: Ensure your wallet is connected
2. **Navigate to Sell Page**: Click "Sell NFT" in the navigation
3. **Enter NFT Details**: Provide contract address and token ID
4. **Set Price**: Choose payment token and set your price
5. **Create Listing**: Approve NFT and complete listing transaction

### Price Service
The marketplace features an advanced price service that:
- Fetches real-time prices from Uniswap v3 pools
- Falls back to CoinGecko API for additional coverage
- Uses smart caching to optimize performance
- Displays price sources for transparency

## 🏗️ Architecture

### Component Structure
```
src/
├── components/          # Reusable UI components
│   ├── ErrorBoundary.jsx    # Error handling components
│   ├── Footer.jsx           # Site footer
│   ├── ListingCard.jsx      # NFT listing display
│   └── Navigation.jsx       # Site navigation
├── context/             # React context providers
│   ├── MarketplaceContext.jsx  # Marketplace state management
│   └── WalletContext.jsx       # Wallet connection state
├── pages/               # Page components
│   ├── HomePage.jsx          # Landing page
│   ├── MarketplacePage.jsx   # NFT listings
│   ├── SellPage.jsx         # Create listings
│   └── ...
├── services/            # External integrations
│   └── priceService.js      # Price fetching service
├── utils/               # Utility functions
│   └── errorUtils.js        # Error handling utilities
└── styles.css           # Global styles
```

### State Management
- **WalletContext**: Manages wallet connection and Web3 provider
- **MarketplaceContext**: Handles marketplace interactions and listings
- **Local State**: Component-specific state for UI interactions

### Error Handling
- **Error Boundaries**: React components that catch JavaScript errors
- **Async Error Handling**: Comprehensive error handling for API calls
- **User-Friendly Messages**: Clear, actionable error messages
- **Logging**: Detailed error logging for debugging

## 🔍 API Reference

### Price Service
```javascript
import { getTokenPriceUSD, getMultipleTokenPrices } from './services/priceService';

// Get single token price
const price = await getTokenPriceUSD(provider, tokenAddress);

// Get multiple token prices
const prices = await getMultipleTokenPrices(provider, [address1, address2]);
```

### Error Utilities
```javascript
import { formatErrorMessage, safeAsync } from './utils/errorUtils';

// Format error for user display
const userMessage = formatErrorMessage(error);

// Execute async function safely
const result = await safeAsync(asyncFunction, fallbackValue, 'Context');
```

## 🧪 Testing

### Manual Testing
1. **Price Service**: Verify real-time price updates in sell page
2. **NFT Listing**: Test creating listings with various NFT types
3. **Purchase Flow**: Complete end-to-end purchase transactions
4. **Error Handling**: Test error scenarios (network failures, invalid inputs)

### Development Tools
- **Browser DevTools**: Monitor network requests and console logs
- **MetaMask**: Test wallet interactions and transaction flows
- **Price Ticker**: Verify live price updates and refresh functionality

## 🚀 Deployment

### Build Optimization
The project includes several optimizations:
- **Code Splitting**: Automatic code splitting for better performance
- **Asset Optimization**: Optimized images and fonts
- **Caching**: Service worker for caching (can be added)

### Production Checklist
- [ ] Environment variables configured
- [ ] Smart contract addresses verified
- [ ] Network configuration tested
- [ ] Error tracking configured (Sentry, etc.)
- [ ] Performance monitoring enabled

## 🤝 Contributing

### Development Guidelines
1. **Code Style**: Follow existing patterns and use ESLint
2. **Error Handling**: Always implement proper error handling
3. **Testing**: Test changes thoroughly before submitting
4. **Documentation**: Update documentation for new features

### Commit Guidelines
- Use conventional commit messages
- Include clear descriptions of changes
- Reference issue numbers when applicable

## 📋 Changelog

### v0.1.0 (Latest)
- ✅ Real-time Uniswap v3 price fetching
- ✅ Comprehensive error handling and boundaries
- ✅ Security vulnerability fixes (updated Vite to 6.0)
- ✅ Enhanced UI/UX with loading states
- ✅ Robust async operation handling
- ✅ Price caching and optimization

## 🔒 Security

### Best Practices
- **Input Validation**: All user inputs are validated
- **Error Handling**: Errors are handled gracefully without exposing sensitive data
- **Network Security**: HTTPS-only connections for external APIs
- **Wallet Security**: No private keys are stored or transmitted

### Known Security Considerations
- Users should verify contract addresses before interacting
- Always confirm transaction details in MetaMask
- Be cautious with custom token additions

## 📞 Support

### Getting Help
- **Issues**: Report bugs via GitHub Issues
- **Questions**: Check existing documentation first
- **Feature Requests**: Submit detailed feature requests with use cases

### Common Issues
1. **MetaMask Not Detected**: Ensure MetaMask is installed and enabled
2. **Network Errors**: Check internet connection and RPC endpoint
3. **Transaction Failures**: Verify sufficient balance and gas fees
4. **Price Loading Issues**: Check if external APIs are accessible

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **Vitruveo**: For providing the blockchain infrastructure
- **Uniswap**: For price feed APIs
- **CoinGecko**: For additional price data
- **React Community**: For the excellent framework and ecosystem

---

**Built with ❤️ for the future of digital art and collectibles**