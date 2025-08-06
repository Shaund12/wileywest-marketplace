# WileyW€$T NFT Marketplace

WileyW€$T is a cyberpunk-themed NFT marketplace built with React 18 and Vite, designed for trading NFTs on the Vitruveo blockchain network. The application uses Ethers.js for blockchain interactions and optionally integrates with Supabase for backend services.

**ALWAYS reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.**

## Working Effectively

### Fresh Environment Setup
Always perform these steps when starting with a fresh clone:

```bash
# Install dependencies - NEVER CANCEL: Takes 3-5 minutes
npm install
```
**TIMEOUT REQUIREMENT**: Set timeout to 10+ minutes for npm install. NEVER CANCEL this command.

```bash
# Build the application - NEVER CANCEL: Takes 8-15 seconds  
npm run build
```
**TIMEOUT REQUIREMENT**: Set timeout to 2+ minutes for build commands. NEVER CANCEL build processes.

### Development Workflow
Start development server:
```bash
npm run dev
```
- Starts on `http://localhost:5173` (or next available port like 5174)
- Hot reload enabled
- Usually ready in 1-2 seconds

Build for production:
```bash
npm run build
```
- Outputs to `dist/` directory
- Takes approximately 8 seconds
- May show React Router warnings (normal)
- May show JSX syntax warnings (non-fatal)

Preview built version:
```bash
npm run preview  
```
- Serves built version on `http://localhost:4173`
- Use this to test production build locally

## Environment Configuration

### Required Environment Variables
Create `.env` file in repository root:
```env
VITE_SUPABASE_URL=https://your-supabase-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key  
VITE_RPC_URL=https://rpc.vitruveo.xyz
VITE_MARKETPLACE_ADDRESS=your-marketplace-contract-address
```

### Testing Without Supabase
For development/testing without Supabase setup, use these placeholder values:
```env
VITE_SUPABASE_URL=https://dummy.supabase.co
VITE_SUPABASE_ANON_KEY=dummy-key-for-testing
VITE_RPC_URL=https://rpc.vitruveo.xyz  
VITE_MARKETPLACE_ADDRESS=0x0000000000000000000000000000000000000000
```

## Validation

### Manual Testing Requirements
**ALWAYS perform these validation steps after making changes:**

1. **Basic Application Flow:**
   ```bash
   npm run dev
   # Navigate to http://localhost:5174
   # Test all main pages: /, /marketplace, /hot-listings, /sell, /profile
   ```

2. **Production Build Testing:**
   ```bash
   npm run build && npm run preview
   # Navigate to http://localhost:4173  
   # Verify same functionality as dev server
   ```

3. **Essential User Scenarios:**
   - Navigate through all main pages using the navigation menu
   - Verify the homepage displays "WileyW€$T NFT Marketplace" title
   - Check that "Explore NFTs" and "Sell Your NFT" buttons are functional
   - Ensure responsive design works (if making UI changes)
   - Test wallet connection flow (if wallet features are modified)

### Known Issues and Limitations

**ESLint Configuration Issue:**
```bash
# This command FAILS - ESLint v9 requires new config format
npx eslint .
# Error: ESLint couldn't find an eslint.config.(js|mjs|cjs) file
```
**DO NOT** run ESLint until configuration is migrated from legacy format.

**Security Vulnerabilities:**
```bash
npm audit
# Shows 3 moderate severity vulnerabilities in esbuild/vite
# Running npm audit fix --force would be a breaking change
```
**DO NOT** run `npm audit fix --force` as it will break the build.

## Code Structure

### Key Directories
- `src/pages/` - React components for each route (HomePage, MarketplacePage, etc.)
- `src/components/` - Reusable UI components (Navigation, Footer, ListingCard)  
- `src/context/` - React Context providers (WalletContext, MarketplaceContext)
- `src/utils/` - Utility functions (tokenUtils.js, nftScanner.js)
- `src/abi/` - Smart contract ABI definitions
- `src/assets/` - Static assets (logos, favicon)

### Important Files
- `src/App.jsx` - Main application component with routing
- `src/context/WalletContext.jsx` - Wallet connection and Web3 provider
- `src/context/MarketplaceContext.jsx` - NFT marketplace state and contract interactions
- `vite.config.js` - Vite build configuration
- `vercel.json` - Vercel deployment configuration with SPA routing

### Blockchain Integration
- **Network**: Vitruveo blockchain (`https://rpc.vitruveo.xyz`)
- **Wallet**: Supports MetaMask and other Web3 wallets via Ethers.js
- **Contracts**: Marketplace contract for NFT trading operations
- **Token Utils**: Price fetching with fallback mechanisms for network issues

## Common Development Tasks

### Adding New Pages
1. Create component in `src/pages/`
2. Add route in `src/App.jsx`  
3. Add navigation link in `src/components/Navigation.jsx`
4. **Always test navigation** after adding new routes

### Modifying Blockchain Integration  
1. **Always check both context files** after making contract changes:
   - `src/context/WalletContext.jsx`
   - `src/context/MarketplaceContext.jsx`
2. **Test wallet connection flow** after any Web3 modifications
3. **Verify error handling** for network issues and failed transactions

### Styling Changes
- Global styles in `src/styles.css`
- Component-specific CSS files alongside components
- **Always test responsive design** after UI changes
- **Verify cyberpunk theme consistency** across all pages

## Deployment

**Platform**: Vercel
- Automatic deployments from main branch
- SPA configuration in `vercel.json` routes all paths to `index.html`
- Static asset caching enabled for optimal performance

**Build Requirements**:
- Node.js environment
- Environment variables must be configured in Vercel dashboard
- Build command: `npm run build`
- Output directory: `dist`

## Troubleshooting

### Common Build Issues
1. **"Module not found" errors**: Run `npm install` to ensure all dependencies are present
2. **Port conflicts**: Vite will automatically use next available port (5174, 5175, etc.)
3. **Environment variable issues**: Verify `.env` file exists and contains required VITE_ prefixed variables

### Performance Considerations
- Build outputs large JavaScript bundle (690KB+ gzipped)
- Consider code splitting for production optimizations
- Price fetching includes retry logic and fallback mechanisms for network restrictions

**CRITICAL REMINDER**: Always set appropriate timeouts for build commands (2+ minutes) and npm install (10+ minutes). NEVER CANCEL long-running operations.