import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { activeChain, chainHasFeature } from '../../config/chains';
import './PricingTransparencyPage.css';

// Fallback used only until the on-chain read resolves, or if it fails.
const FALLBACK_FEE_BPS = 250;

const MARKETPLACE_FEE_ABI = [
  'function platformFeeBps() view returns (uint256)',
  'function vibeShareBps() view returns (uint16)'
];

function formatPct(bps) {
  // 250 -> "2.5", 300 -> "3", 275 -> "2.75"
  return String(Number((bps / 100).toFixed(2)));
}

function PricingTransparencyPage() {
  const [feeBps, setFeeBps] = useState(null);
  const [vibeBps, setVibeBps] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const chain = activeChain();
        if (!chain?.rpcUrl || !chain?.marketplaceAddress) return;

        const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
        const marketplace = new ethers.Contract(
          chain.marketplaceAddress,
          MARKETPLACE_FEE_ABI,
          provider
        );
        const bps = Number((await marketplace.platformFeeBps()).toString());
        if (!cancelled && Number.isFinite(bps)) setFeeBps(bps);

        // VIBE is a Vitruveo-only primitive; the getter does not exist on Hyve.
        if (chainHasFeature('vibe')) {
          try {
            const vibe = Number((await marketplace.vibeShareBps()).toString());
            if (!cancelled && Number.isFinite(vibe)) setVibeBps(vibe);
          } catch (vibeErr) {
            console.warn('[Pricing] Could not read vibeShareBps:', vibeErr.message);
          }
        }
      } catch (err) {
        // Leave feeBps null; the page renders the documented fallback rate.
        console.warn('[Pricing] Could not read platformFeeBps:', err.message);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const liveFee = feeBps !== null;
  const bps = liveFee ? feeBps : FALLBACK_FEE_BPS;
  const pct = formatPct(bps);
  const chainName = activeChain()?.name || 'the active chain';
  const hasVibe = chainHasFeature('vibe');

  // Worked example, recomputed from whatever rate is in effect.
  const examplePlatformFee = (100 * bps) / 10000;
  const exampleRoyalty = 5;
  const exampleSellerNet = 100 - examplePlatformFee - exampleRoyalty;
  const exampleBuyerTotal = 100 + examplePlatformFee + exampleRoyalty;
  const fmt = (n) => n.toFixed(3);

  return (
    <div className="pricing-page">
      <div className="pricing-container">
        <div className="pricing-header">
          <h1>Marketplace Fees & Pricing</h1>
          <p className="subtitle">Fees that may apply when you buy, sell, or bid on BlockDust</p>
        </div>

        <div className="pricing-content">
          <section className="content-section highlight">
            <h2>Read Before You Transact</h2>
            <p>
              By buying, selling, bidding, or settling an auction, you acknowledge the fees
              described on this page. Review the final amount in BlockDust and your wallet
              before approving a blockchain transaction; confirmed transactions are irreversible.
            </p>
          </section>

          <section className="content-section">
            <h2>Marketplace Fees</h2>
            <p>
              The marketplace contract currently applies the following fees to fixed-price
              sales and completed auctions. One basis point (bps) is 0.01%.
            </p>
            <div className="fee-breakdown">
              <div className="fee-item">
                <span className="fee-label">Platform fee</span>
                <span className="fee-value">{bps} bps ({pct}%)</span>
              </div>
              <div className="fee-item">
                <span className="fee-label">Creator royalty</span>
                <span className="fee-value">NFT-specific; may be zero</span>
              </div>
            </div>
            <p className="note">
              <strong>Buyer:</strong> the amount required for a purchase may include the listed
              price or winning bid, the platform fee, and any creator royalty. Gas and any
              applicable tax are separate. <strong>Seller:</strong> proceeds are the sale price
              minus the platform fee and creator royalty.
            </p>
            <p>
              {liveFee
                ? `This rate was read from the ${chainName} marketplace contract when you loaded this page.`
                : `This is the rate most recently documented for the ${chainName} marketplace contract; the live value could not be read just now.`}
              {' '}The rate is an owner-settable marketplace-contract value, not a permanent
              guaranteed rate. The rate in effect when the transaction executes controls.
            </p>
          </section>

          <section className="content-section">
            <h2>How Sale Proceeds Are Distributed</h2>
            <p>
              The marketplace contract applies deductions in this order:
            </p>
            <ol>
              <li>Start with the fixed sale price or final winning bid.</li>
              <li>Deduct the platform fee.</li>
              <li>Split that platform fee between any VIBE share and the protocol portion.</li>
              <li>Deduct the NFT contract's creator royalty, if any.</li>
              <li>Pay the remaining proceeds to the seller.</li>
            </ol>
            <p className="note">
              A VIBE share is part of the platform fee, not an additional fee.
              {!hasVibe && ` VIBE processing does not exist on ${chainName}, so the entire platform fee is the protocol portion.`}
              {hasVibe && vibeBps !== null && ` The share currently configured on ${chainName} is ${formatPct(vibeBps)}%${vibeBps === 0 ? ', so the entire platform fee is presently the protocol portion' : ''}.`}
              {hasVibe && vibeBps === null && ' The configured share could not be read just now; the transaction screen and your wallet show the amounts that will actually apply.'}
            </p>
          </section>

          <section className="content-section">
            <h2>100 VTRU Example</h2>
            <p>
              This example uses the {pct}% platform fee shown above and an illustrative 5% NFT
              royalty. The actual royalty is determined by the NFT contract.
            </p>
            <div className="example-box">
              <h4>Seller proceeds from a 100 VTRU sale</h4>
              <div className="example-row">
                <span>Sale price</span>
                <span>100.000 VTRU</span>
              </div>
              <div className="example-row">
                <span>Platform fee ({pct}%)</span>
                <span>−{fmt(examplePlatformFee)} VTRU</span>
              </div>
              <div className="example-row">
                <span>Illustrative creator royalty (5%)</span>
                <span>−{fmt(exampleRoyalty)} VTRU</span>
              </div>
              <div className="example-row total-row">
                <span><strong>Seller receives</strong></span>
                <span><strong>{fmt(exampleSellerNet)} VTRU</strong></span>
              </div>
            </div>
            <p className="note">
              In this example, the buyer may be required to authorize {fmt(exampleBuyerTotal)} VTRU
              plus gas: 100 VTRU price + {fmt(examplePlatformFee)} VTRU platform fee
              + {fmt(exampleRoyalty)} VTRU royalty. The transaction screen
              and wallet confirmation show the amount to approve.
            </p>
          </section>

          <section className="content-section">
            <h2>Creator Royalties</h2>
            <p>
              Royalties are requested from the NFT contract for the token ID and sale price,
              using the ERC-2981 royalty interface. If the NFT contract returns a royalty,
              the marketplace records the amount and receiver on-chain and includes it in
              the sale settlement. BlockDust does not set one universal royalty percentage.
            </p>
          </section>

          <section className="content-section">
            <h2>Auctions</h2>
            <ul>
              <li>Completed auctions use the same platform-fee and royalty deductions as fixed-price sales.</li>
              <li>Each auction sets a minimum bid increment in bps; a new bid must satisfy that minimum.</li>
              <li>Bids placed near the end may extend the auction under its anti-snipe window.</li>
              <li>The winner pays the final bid and applicable fees; losing or replaced bids are handled by the marketplace contract.</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>Chains, Payment Tokens & Gas</h2>
            <p>
              BlockDust supports Hyve (chain ID 7847) and Vitruveo (chain ID 1490).
              VIBE processing and RevShare are Vitruveo-only capabilities; they do not
              exist on Hyve. The figures on this page reflect {chainName}, the chain you
              currently have selected.
            </p>
            <ul>
              <li>A listing or auction may use the chain's native token or the ERC-20 token selected for that listing.</li>
              <li>The platform-fee percentage does not change merely because an ERC-20 is used.</li>
              <li>Gas is paid separately in the chain's native token and goes to network validators, not BlockDust.</li>
              <li>Token symbols and approximate fiat values are informational; the on-chain token address and amount control.</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>Taxes</h2>
            <p className="note">
              Taxes may apply depending on your location and circumstances. Any tax collected
              by BlockDust will be shown separately before confirmation. You remain responsible
              for taxes not collected by the platform. BlockDust does not provide tax advice.
            </p>
          </section>

          <section className="content-section">
            <h2>Refunds & Finality</h2>
            <p>
              Sales settle on a public blockchain. Once a transaction is confirmed it is
              irreversible, and BlockDust cannot reverse it, recover transferred funds or
              NFTs, or undo a transfer on your behalf. Fixed-price purchases settle in a
              single transaction that pays the seller, any royalty receiver, and the
              platform fee directly. In an auction, the marketplace contract holds bid funds
              until the auction is settled or the bid is replaced or cancelled, as the
              contract provides.
            </p>
            <p>
              This means BlockDust does not offer refunds. Please review the token, the
              price, and the total shown in your wallet before approving any transaction.
            </p>
            <p>
              You can still report problems — a fraudulent or infringing listing, a listing
              that misrepresents the NFT, or a fault in this interface — at{' '}
              <a href="mailto:support@blockdust.xyz">support@blockdust.xyz</a>. We can act on
              what we control, such as removing a listing or delisting a collection, and we
              will tell you what we are able to do. Reporting a problem is not a guarantee
              of compensation, and nothing here limits any rights you may have under
              applicable law.
            </p>
          </section>
        </div>

        <div className="pricing-footer">
          <p>
            <strong>Still have questions?</strong> Our support team is here to help:<br />
            <a href="mailto:support@blockdust.xyz">support@blockdust.xyz</a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default PricingTransparencyPage;
