// pages/CollectionPage.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import ListingCard from '../components/ListingCard'; // ✅ add this

const ERC721_METADATA_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
];

const isAddress = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');

export default function CollectionPage() {
    const { address = '' } = useParams();
    const addr = address.toLowerCase();
    const { listings = [], isInitialized, fetchListings } = useMarketplace();
    const { provider } = useWallet();

    const [label, setLabel] = useState('');
    const [labelLoading, setLabelLoading] = useState(false);

    useEffect(() => {
        if (!isInitialized && typeof fetchListings === 'function') {
            fetchListings().catch(() => { });
        }
    }, [isInitialized, fetchListings]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!provider || !isAddress(addr)) {
                setLabel('');
                return;
            }
            setLabelLoading(true);
            try {
                const c = new ethers.Contract(addr, ERC721_METADATA_ABI, provider);
                let n = '';
                try { n = await c.name(); } catch { }
                if (!n) { try { n = await c.symbol(); } catch { } }
                if (!cancelled) setLabel((n || '').trim());
            } catch {
                if (!cancelled) setLabel('');
            } finally {
                if (!cancelled) setLabelLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [addr, provider]);

    const items = useMemo(() => {
        if (!Array.isArray(listings)) return [];
        return listings.filter((l) => (l?.nftContract || '').toLowerCase() === addr);
    }, [listings, addr]);

    if (!isAddress(addr)) {
        return (
            <div className="hp" style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head"><h2>Invalid collection</h2></div>
                <EmptyState
                    icon="⚠️"
                    title="That doesn’t look like a valid contract address."
                    description="Double-check the URL or pick a collection from the marketplace."
                    actionText="Back to Marketplace"
                    onAction={() => (window.location.href = '/marketplace')}
                />
            </div>
        );
    }

    return (
        <div className="hp">
            <section className="hp-featured" style={{ marginTop: '2rem' }}>
                <div className="hp-section__head">
                    <h2>{labelLoading ? 'Loading…' : label || `${addr.slice(0, 6)}…${addr.slice(-4)}`}</h2>
                    <Link to="/marketplace" className="hp-link">Back to marketplace →</Link>
                </div>

                {!isInitialized ? (
                    <LoadingSkeleton type="card" count={8} className="grid" />
                ) : items.length === 0 ? (
                    <EmptyState
                        icon="🧩"
                        title="No live listings for this collection"
                        description="When someone lists from this contract, it’ll show up here."
                        actionText="Explore other NFTs"
                        onAction={() => (window.location.href = '/marketplace')}
                    />
                ) : (
                    <div className="hp-latest__grid">
                        {items.slice(0, 40).map((l) => (
                            <ListingCard key={l.id} listing={l} />  {/* ✅ direct use */ }
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
