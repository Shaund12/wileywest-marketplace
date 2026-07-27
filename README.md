# BlockDust NFT Marketplace

<div align="center">
  <h2>🌆 Cyberpunk NFT Trading Platform 🌆</h2>
  <p>A cutting-edge multichain NFT marketplace with a cyberpunk aesthetic</p>
  
  ![React](https://img.shields.io/badge/React-18.2.0-61DAFB?style=for-the-badge&logo=react&logoColor=white)
  ![Vite](https://img.shields.io/badge/Vite-4.0.0-646CFF?style=for-the-badge&logo=vite&logoColor=white)
  ![Ethers.js](https://img.shields.io/badge/Ethers.js-6.9.0-2535A0?style=for-the-badge&logo=ethereum&logoColor=white)
  ![Hyve](https://img.shields.io/badge/Hyve-Blockchain-yellow?style=for-the-badge)
  ![Vitruveo](https://img.shields.io/badge/Vitruveo-Blockchain-purple?style=for-the-badge)
  ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Self--Hosted-336791?style=for-the-badge&logo=postgresql&logoColor=white)
</div>

## 🚀 Features

- **🎨 NFT Trading**: Buy, sell, and discover unique digital assets
- **🏁 Auction System**: Complete auction platform with bidding, reserves, and settlements
- **🔗 Multichain**: Runs on Hyve (default) and Vitruveo, switchable at runtime
- **🗄️ Self-Hosted Backend**: Express + PostgreSQL, no third-party database service
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

Supported chains and their contract addresses live in
[src/config/chains.js](src/config/chains.js) — Hyve (7847, default) and
Vitruveo (1490). Chain selection is a runtime user choice, so there is no
"active chain" env var. Every value below is optional and falls back to the
defaults baked into that file.

```env
# Per-chain overrides (VITE_<CHAINKEY>_<FIELD>)
VITE_HYVE_MARKETPLACE_ADDRESS=0x89610b27E8f5685681666edf901Ad5c69d89DfB6
VITE_VITRUVEO_MARKETPLACE_ADDRESS=0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854

# Legacy single-chain vars, still honored as the Vitruveo fallback
VITE_RPC_URL=https://rpc.vitruveo.ai
VITE_MARKETPLACE_ADDRESS=0x67cfCf4bE8447a083E6A2A1135Bd998FE91d3854

# Only needed if the backend is on a DIFFERENT origin than the SPA
# VITE_API_BASE_URL=https://api.blockdust.xyz
```

Vitruveo-only DeFi features (Vibe, RevShare, WVTRU wrapping, Uniswap pricing)
are declared per-chain in the `features` map and are chain-gated in the UI —
they are hidden while Hyve is active.

### Backend Configuration

The backend process (not the Vite build) reads:

```env
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/blockdust
PORT=8787
ENABLE_CRONS=true
```

### Environment Files Reference

- **`.env.example`** - Template with all supported variables
- **`backend/SETUP.md`** - Backend, database, and deployment setup
- **`docs/legacy/`** - Archived docs from the retired Supabase/Vercel stack

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
4. **Run the tests**: `npm test`
5. **Test Locally**: Navigate through all pages to verify functionality

> `npm run dev` serves the SPA but **not** `/api/*`. Anything that reads or
> writes data also needs the backend running — see [backend/SETUP.md](backend/SETUP.md).

### Testing

```bash
npm test              # unit + API tests; no database required
npm run test:watch    # re-run on change
npm run test:smoke    # end-to-end against a RUNNING backend
```

Full details, including how to point smoke tests at a deployed environment,
are in [tests/README.md](tests/README.md).

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

### Self-Hosted (Current Setup)

The app is deployed as a single Node service that serves the built SPA *and*
the API. See [backend/SETUP.md](backend/SETUP.md) for the full walkthrough.

```bash
# 1. Build the frontend
npm run build

# 2. Create the database and apply the schema
psql -d blockdust -f backend/db/schema.sql

# 3. Install and start the backend (serves ../dist + /api/*)
cd backend && npm install
node server.js          # or use the systemd unit below
```

Install the provided systemd unit for a managed service:

```bash
sudo cp backend/blockdust-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blockdust-backend
sudo journalctl -u blockdust-backend -f
```

The backend runs the former cron jobs as internal `setInterval` loops
(`sync-listings` every 5 min, prewarm queue every 2 min), so no external cron
pinger is needed. Set `ENABLE_CRONS=false` to disable them.

> **Note**: This project previously deployed to Vercel with a Supabase backend.
> Both have been fully retired — see `docs/legacy/` for the archived docs.

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
│   ├── SupabaseContext.jsx   # Data access (Postgres via pgRestClient shim)
│   └── ThemeContext.jsx      # Theme state
├── config/
│   └── chains.js        # Multichain registry (Hyve + Vitruveo)
├── lib/
│   └── pgRestClient.js  # Supabase-compatible client over /api/db
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
- **Backend**: Express (`backend/`) serving the SPA, `/api/*`, and internal crons
- **Database**: Self-hosted PostgreSQL, reached via the `/api/db` PostgREST-lite endpoint
- **Styling**: CSS with cyberpunk theme

### State Management

- **WalletContext**: Manages Web3 wallet connections and provider
- **MarketplaceContext**: Handles NFT data, marketplace state, and contract interactions
- **SupabaseContext**: Data-access provider. Despite the name, it no longer
  touches Supabase — it instantiates the `createPgRestClient()` shim in
  [src/lib/pgRestClient.js](src/lib/pgRestClient.js), which reproduces the
  Supabase fluent API (`.from().select().eq()`, `.rpc()`, `.channel()`) over
  the local Postgres backend. Keeping that surface is why the page components
  never had to change during the migration. Realtime channels are no-ops.

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
- **Caching**: Smart data caching backed by PostgreSQL (metadata/image caches)
- **Error Handling**: Robust error recovery and fallback mechanisms
- **Responsive Design**: Mobile-first responsive layout

## 📚 API Reference

### Environment Variables

#### Core Configuration

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `VITE_HYVE_MARKETPLACE_ADDRESS` | Hyve marketplace contract | No | see `chains.js` |
| `VITE_VITRUVEO_MARKETPLACE_ADDRESS` | Vitruveo marketplace contract | No | see `chains.js` |
| `VITE_RPC_URL` | Legacy Vitruveo RPC fallback | No | `https://rpc.vitruveo.ai` |
| `VITE_MARKETPLACE_ADDRESS` | Legacy Vitruveo contract fallback | No | see `chains.js` |
| `VITE_API_BASE_URL` | Backend origin, if not same-origin | No | same-origin |

Backend-process variables (`DATABASE_URL`, `PORT`, `ENABLE_CRONS`) are
documented in [backend/SETUP.md](backend/SETUP.md).

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

- **ESLint v9**: no `eslint.config.js` exists yet, so `npx eslint .` fails.
  Migrating off the legacy config format is outstanding work.
- **Security advisories**: `npm audit` reports a substantial number, the bulk
  of them transitive dependencies of the wallet SDKs (`@reown/appkit`,
  `@metamask/sdk`). `npm audit fix --force` downgrades/breaks those SDKs —
  don't run it casually. Re-check the count before quoting a number; it moves
  as upstream publishes.
- **Bundle Size**: the main chunk is ~1.7 MB (~480 kB gzipped) and exceeds the
  600 kB warning threshold. Further code splitting is worthwhile.

### Getting Help

- **Documentation**: Check [backend/SETUP.md](backend/SETUP.md) and [docs/compliance.md](docs/compliance.md)
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