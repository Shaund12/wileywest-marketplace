# BlockDust NFT Marketplace

<div align="center">
  <h2>🌆 Cyberpunk NFT Trading Platform 🌆</h2>
  <p>A cutting-edge NFT marketplace built for the Vitruveo blockchain with a cyberpunk aesthetic</p>
  
  ![React](https://img.shields.io/badge/React-18.2.0-61DAFB?style=for-the-badge&logo=react&logoColor=white)
  ![Vite](https://img.shields.io/badge/Vite-4.0.0-646CFF?style=for-the-badge&logo=vite&logoColor=white)
  ![Ethers.js](https://img.shields.io/badge/Ethers.js-6.9.0-2535A0?style=for-the-badge&logo=ethereum&logoColor=white)
  ![Vitruveo](https://img.shields.io/badge/Vitruveo-Blockchain-purple?style=for-the-badge)
</div>

## 🚀 Features

- **🎨 NFT Trading**: Buy, sell, and discover unique digital assets
- **🏁 Auction System**: Complete auction platform with bidding, reserves, and settlements
- **🔗 Blockchain Integration**: Built on the Vitruveo network with Web3 wallet support
- **⚡ High Performance**: Lightning-fast React 18 with Vite build system and code splitting
- **🎮 Cyberpunk Theme**: Immersive futuristic design and user experience
- **📱 Responsive Design**: Optimized for desktop and mobile devices
- **🔒 Secure**: Smart contract-based transactions with MetaMask integration
- **📊 Real-time Data**: Live marketplace statistics and price tracking
- **🗃️ Smart Caching**: Intelligent data persistence with rate limiting
- **🚀 Production Ready**: Comprehensive error handling and optimized performance

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Environment Setup](#-environment-setup)
- [Development](#-development)
- [Building](#-building)
- [Deployment](#-deployment)
- [Architecture](#-architecture)
- [Features](#-features-detail)
- [API Reference](#-api-reference)
- [Contributing](#-contributing)
- [Troubleshooting](#-troubleshooting)
- [License](#-license)

## ⚡ Quick Start

```bash
# Clone the repository
git clone https://github.com/Shaund12/wileywest-marketplace.git
cd wileywest-marketplace

# Install dependencies (takes 3-5 minutes)
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Start development server
npm run dev

# Open http://localhost:5173 in your browser
```

## 📦 Installation

### Prerequisites

- **Node.js** 16.0.0 or higher
- **npm** 7.0.0 or higher
- **MetaMask** or compatible Web3 wallet
- **Git** for version control

### Dependencies Installation

```bash
# Install all dependencies (NEVER CANCEL - takes 3-5 minutes)
npm install
```

**⚠️ Important**: The npm install process takes 3-5 minutes. Do not cancel this operation as it may leave your installation in an inconsistent state.

## 🔧 Environment Setup

### Required Environment Variables

Create a `.env` file in the root directory:

```env
# Blockchain Configuration
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=your-marketplace-contract-address

# Supabase Configuration (Optional)
VITE_SUPABASE_URL=https://your-supabase-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

### Testing Configuration

For development and testing without Supabase setup:

```env
# Blockchain Configuration
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=0x0000000000000000000000000000000000000000

# Supabase Configuration (Dummy values for testing)
VITE_SUPABASE_URL=https://dummy.supabase.co
VITE_SUPABASE_ANON_KEY=dummy-key-for-testing
```

### Environment Files Reference

- **`.env.example`** - Template with all required variables
- **`ENV_SETUP.md`** - Detailed environment configuration guide
- **`SUPABASE_INTEGRATION.md`** - Supabase setup instructions

## 🛠️ Development

### Development Server

```bash
# Start the development server
npm run dev

# Server will start on http://localhost:5173
# Hot reload is enabled for instant updates
```

### Development Workflow

1. **Start Development**: `npm run dev`
2. **Make Changes**: Edit files in `src/` directory
3. **Hot Reload**: Changes appear instantly in browser
4. **Test Locally**: Navigate through all pages to verify functionality

### Key Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Check for security vulnerabilities
npm audit
```

## 🏗️ Building

### Production Build

```bash
# Build the application (takes 8-15 seconds)
npm run build
```

The build process:
- Outputs to `dist/` directory
- Optimizes JavaScript and CSS
- Generates static assets for deployment
- Creates ~750KB JavaScript bundle (gzipped: ~237KB)

### Build Artifacts

```
dist/
├── index.html              # Main HTML file
├── assets/
│   ├── index-[hash].js     # JavaScript bundle
│   ├── index-[hash].css    # Stylesheet
│   └── blockdust-logo.png  # Application logo
```

### Preview Build

```bash
# Preview the production build locally
npm run preview

# Serves on http://localhost:4173
```

## 🚀 Deployment

### Vercel Deployment (Recommended)

The application is configured for Vercel deployment:

1. **Connect Repository**: Link your GitHub repository to Vercel
2. **Environment Variables**: Set up environment variables in Vercel dashboard
3. **Deploy**: Automatic deployments from main branch

### Vercel Configuration

```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### Manual Deployment

For other hosting providers:

1. **Build**: `npm run build`
2. **Upload**: Upload `dist/` folder contents
3. **Configure**: Set up SPA routing (all routes → index.html)

## 🏛️ Architecture

### Project Structure

```
src/
├── components/          # Reusable UI components
│   ├── Navigation.jsx   # Main navigation bar
│   ├── Footer.jsx       # Site footer
│   ├── ListingCard.jsx  # NFT listing display
│   ├── LazyNftGrid.jsx  # Optimized NFT grid
│   ├── MarketplaceStats.jsx # Real-time statistics
│   └── compliance/      # Compliance components (feature-flagged)
│       └── SanctionsModal.jsx # Sanctions warning modal
├── pages/               # Route components
│   ├── HomePage.jsx     # Landing page
│   ├── MarketplacePage.jsx # NFT marketplace
│   ├── HotListingsPage.jsx # Trending NFTs
│   ├── SellPage.jsx     # Create listings
│   ├── ProfilePage.jsx  # User profile
│   ├── legal/           # Legal & compliance pages (feature-flagged)
│   │   ├── DMCAPage.jsx          # DMCA takedown form
│   │   ├── WISPPage.jsx          # Security program docs
│   │   ├── SanctionsPage.jsx    # Sanctions policy
│   │   └── PricingTransparencyPage.jsx # Pricing & tax info
│   └── admin/           # Admin pages (feature-flagged)
│       ├── DMCAAdminPage.jsx     # DMCA review interface
│       └── ComplianceAdminPage.jsx # Compliance settings
├── context/             # React Context providers
│   ├── WalletContext.jsx    # Web3 wallet management
│   ├── MarketplaceContext.jsx # NFT marketplace state
│   └── SupabaseContext.jsx   # Database integration
├── utils/               # Utility functions
│   ├── tokenUtils.js    # Price fetching & token operations
│   ├── nftScanner.js    # Blockchain NFT discovery
│   └── compliance/      # Compliance utilities (feature-flagged)
│       ├── featureFlags.js       # Feature flag management
│       ├── sanctionsAdapter.js   # Sanctions screening
│       └── taxCalculator.js      # Tax calculations
├── hooks/               # Custom React hooks
│   └── useSanctionsGate.js # Sanctions gate hook
├── abi/                 # Smart contract ABIs
│   └── Marketplace.json # Marketplace contract ABI
└── assets/             # Static assets
    └── blockdust-logo.png # Application logo
```

### Application Routes

**Main Routes:**
- `/` - Homepage
- `/marketplace` - NFT marketplace
- `/hot-listings` - Trending NFTs
- `/sell` - Create listings
- `/profile` - User profile
- `/terms` - Terms of service
- `/privacy` - Privacy policy

**Compliance Routes** (Feature-Flagged):
- `/legal/dmca` - DMCA takedown form (Flag: `VITE_FLAG_DMCA`)
- `/legal/wisp` - WISP documentation (Flag: `VITE_FLAG_WISP`)
- `/legal/sanctions` - Sanctions policy (Flag: `VITE_FLAG_SANCTIONS`)
- `/legal/pricing` - Pricing transparency (Flag: `VITE_FLAG_TAX_SWITCH`)
- `/admin/dmca` - DMCA admin interface (Flag: `VITE_FLAG_DMCA`)
- `/admin/compliance` - Compliance settings (Flag: Multiple)

**Note**: Compliance routes only render when their respective feature flags are enabled. With all flags disabled (default), these routes return 404.

### Core Technologies

- **Frontend**: React 18 with functional components and hooks
- **Build Tool**: Vite for fast development and optimized builds
- **Routing**: React Router DOM v7 for client-side navigation
- **Blockchain**: Ethers.js v6 for Web3 interactions
- **Database**: Supabase for optional backend services
- **Styling**: CSS with cyberpunk theme

### State Management

- **WalletContext**: Manages Web3 wallet connections and provider
- **MarketplaceContext**: Handles NFT data, marketplace state, and contract interactions
- **SupabaseContext**: Manages database connections and caching

## 🎯 Features Detail

### NFT Marketplace

- **Browse NFTs**: Discover digital assets with advanced filtering
- **Buy & Sell**: Secure blockchain-based transactions
- **Price Discovery**: Real-time price tracking and market statistics
- **Hot Listings**: Trending and popular NFTs

### Wallet Integration

- **MetaMask Support**: Connect with MetaMask wallet
- **Multi-Wallet**: Compatible with Web3-enabled wallets
- **Network Management**: Automatic Vitruveo network configuration
- **Transaction Handling**: Secure smart contract interactions

### Compliance Features (Optional, Feature-Flagged)

- **DMCA Takedown System**: Copyright infringement reporting and management
- **WISP Documentation**: Written Information Security Program
- **Sanctions Screening**: OFAC and sanctions list checking
- **MA Tax Collection**: Massachusetts marketplace facilitator tax compliance

**Note**: All compliance features are disabled by default and controlled by feature flags. See [Compliance Documentation](docs/compliance.md) for details.

### Performance Features

- **Lazy Loading**: Optimized NFT grid with progressive loading
- **Caching**: Smart data caching with Supabase integration
- **Error Handling**: Robust error recovery and fallback mechanisms
- **Responsive Design**: Mobile-first responsive layout

## 📚 API Reference

### Environment Variables

#### Core Configuration

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `VITE_RPC_URL` | Vitruveo RPC endpoint | Yes | `https://rpc.vitruveo.xyz` |
| `VITE_MARKETPLACE_ADDRESS` | Smart contract address | Yes | - |
| `VITE_SUPABASE_URL` | Supabase project URL | No | - |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key | No | - |

#### Compliance Feature Flags (Default: OFF)

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_FLAG_DMCA` | Enable DMCA takedown system | `0` |
| `VITE_FLAG_WISP` | Enable WISP documentation | `0` |
| `VITE_FLAG_SANCTIONS` | Enable sanctions screening | `0` |
| `VITE_FLAG_TAX_SWITCH` | Enable MA tax collection | `0` |

#### Compliance Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_OFAC_PROVIDER` | Sanctions provider (local\|trm\|chainalysis) | `local` |
| `VITE_TAX_GEO_MODE` | Tax geo mode (none\|ip\|self_declare) | `none` |
| `VITE_DMCA_AGENT_EMAIL` | DMCA agent contact email | `legal@blockdust.xyz` |

### Smart Contract Integration

The marketplace integrates with a custom smart contract on Vitruveo:

```javascript
// Contract ABI location
src/abi/Marketplace.json

// Key contract methods
- listItem(tokenId, price)
- buyItem(tokenId)
- cancelListing(tokenId)
- getListings()
```

## 🤝 Contributing

### Development Guidelines

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/amazing-feature`
3. **Test** your changes: `npm run build && npm run preview`
4. **Commit** changes: `git commit -m 'Add amazing feature'`
5. **Push** to branch: `git push origin feature/amazing-feature`
6. **Open** a Pull Request

### Code Style

- **ESLint**: Follow existing linting rules
- **Components**: Use functional components with hooks
- **Naming**: Use descriptive variable and function names
- **Comments**: Add comments for complex logic only

### Testing Checklist

Before submitting changes:

- [ ] `npm run build` completes successfully
- [ ] All main pages load correctly (`/`, `/marketplace`, `/hot-listings`, `/sell`, `/profile`)
- [ ] Wallet connection functionality works
- [ ] Responsive design is maintained
- [ ] No console errors in browser

## 🔧 Troubleshooting

### Common Issues

#### Build Failures

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Clear build cache
rm -rf dist
npm run build
```

#### Wallet Connection Issues

- Ensure MetaMask is installed and unlocked
- Check network is set to Vitruveo
- Verify RPC URL in environment variables

#### Development Server Issues

```bash
# Check if port is available
lsof -i :5173

# Start on different port
npm run dev -- --port 5174
```

#### Environment Variable Issues

- Verify `.env` file exists in root directory
- Ensure all `VITE_` prefixed variables are set
- Restart development server after changing environment variables

### Known Limitations

- **ESLint v9**: Configuration needs migration from legacy format
- **Security Vulnerabilities**: 3 moderate severity in build dependencies (safe for production)
- **Bundle Size**: Large JavaScript bundle (consider code splitting for optimization)

### Getting Help

- **Documentation**: Check `ENV_SETUP.md`, `SUPABASE_INTEGRATION.md`
- **Issues**: Report bugs on GitHub Issues
- **Discussions**: Use GitHub Discussions for questions

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <p>🌆 Built with ❤️ for the cyberpunk NFT community 🌆</p>
  <p>
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-installation">Installation</a> •
    <a href="#-development">Development</a> •
    <a href="#-contributing">Contributing</a>
  </p>
</div>