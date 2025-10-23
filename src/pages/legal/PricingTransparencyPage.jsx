import React from 'react';
import './PricingTransparencyPage.css';

function PricingTransparencyPage() {
  return (
    <div className="pricing-page">
      <div className="pricing-container">
        <div className="pricing-header">
          <h1>Pricing Transparency & Tax Information</h1>
          <p className="subtitle">Understanding fees, taxes, and total costs on BlockDust</p>
        </div>

        <div className="pricing-content">
          <section className="content-section highlight">
            <h2>🎯 Our Commitment to Transparency</h2>
            <p>
              At BlockDust, we believe in complete pricing transparency. You should always
              know exactly what you're paying before completing a transaction.
            </p>
          </section>

          <section className="content-section">
            <h2>Marketplace Fees</h2>
            <p>
              BlockDust charges a small platform fee on each NFT sale to support our
              operations, development, and community initiatives.
            </p>
            <div className="fee-breakdown">
              <div className="fee-item">
                <span className="fee-label">Platform Fee:</span>
                <span className="fee-value">2.5%</span>
              </div>
              <div className="fee-item">
                <span className="fee-label">Creator Royalty:</span>
                <span className="fee-value">0-10% (set by creator)</span>
              </div>
            </div>
            <p className="note">
              These fees are automatically calculated and deducted from the sale price.
              Buyers pay the listed price, and sellers receive the net amount after fees.
            </p>
          </section>

          <section className="content-section">
            <h2>Sales Tax (Massachusetts)</h2>
            <p>
              In certain circumstances, Massachusetts sales tax may apply to NFT transactions
              on our platform. This is to comply with state tax regulations for marketplace
              facilitators.
            </p>
            
            <h3>When Does Tax Apply?</h3>
            <p>Sales tax is applied when <strong>ALL</strong> of the following conditions are met:</p>
            <ol>
              <li>The tax collection feature is enabled (determined by admin)</li>
              <li>The NFT collection is designated as taxable</li>
              <li>Our platform GMV exceeds the facilitator threshold ($100,000)</li>
              <li>The buyer is located in Massachusetts</li>
            </ol>

            <h3>Tax Rate</h3>
            <div className="fee-breakdown">
              <div className="fee-item">
                <span className="fee-label">MA Sales Tax Rate:</span>
                <span className="fee-value">6.25%</span>
              </div>
            </div>

            <p className="note">
              When applicable, tax is added to the listing price at checkout.
              You'll see "Total (incl. tax)" displayed before confirming your purchase.
            </p>
          </section>

          <section className="content-section">
            <h2>Price Display</h2>
            <p>
              We display prices in multiple formats for your convenience:
            </p>
            <ul>
              <li><strong>Native Currency (VTRU):</strong> The blockchain's native token</li>
              <li><strong>USD Equivalent:</strong> Approximate value in US dollars</li>
              <li><strong>Tax (when applicable):</strong> Clearly separated line item</li>
              <li><strong>Total:</strong> All-inclusive final amount</li>
            </ul>

            <div className="example-box">
              <h4>Example Price Breakdown:</h4>
              <div className="example-row">
                <span>NFT Price:</span>
                <span>100 VTRU (~$50.00)</span>
              </div>
              <div className="example-row">
                <span>Platform Fee (2.5%):</span>
                <span>2.5 VTRU (~$1.25)</span>
              </div>
              <div className="example-row">
                <span>Creator Royalty (5%):</span>
                <span>5 VTRU (~$2.50)</span>
              </div>
              <div className="example-row highlight-row">
                <span>Sales Tax (MA, 6.25%):</span>
                <span>6.25 VTRU (~$3.13)</span>
              </div>
              <div className="example-row total-row">
                <span><strong>Total (incl. tax):</strong></span>
                <span><strong>106.25 VTRU (~$53.13)</strong></span>
              </div>
            </div>
          </section>

          <section className="content-section">
            <h2>Blockchain Fees (Gas)</h2>
            <p>
              In addition to platform and tax fees, blockchain transactions require "gas"
              fees paid to network validators. These fees:
            </p>
            <ul>
              <li>Go directly to blockchain validators, not to BlockDust</li>
              <li>Vary based on network congestion</li>
              <li>Are displayed before you confirm each transaction</li>
              <li>Are typically very low on Vitruveo network</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>Tax Exemptions & Questions</h2>
            <p>
              If you believe you qualify for a tax exemption or have questions about
              tax applicability:
            </p>
            <ul>
              <li>Contact our tax compliance team: <a href="mailto:tax@blockdust.xyz">tax@blockdust.xyz</a></li>
              <li>Provide your wallet address and exemption documentation</li>
              <li>We'll review and respond within 3-5 business days</li>
            </ul>
            <p className="note">
              <strong>Note:</strong> BlockDust is not a tax advisor. For specific tax advice,
              please consult a qualified tax professional.
            </p>
          </section>

          <section className="content-section">
            <h2>Refund Policy</h2>
            <p>
              Due to the nature of blockchain transactions, all NFT sales are final.
              However, in cases of:
            </p>
            <ul>
              <li>Technical errors or platform malfunctions</li>
              <li>Fraudulent listings or copyright infringement</li>
              <li>Significant discrepancies between listing and actual NFT</li>
            </ul>
            <p>
              Please contact our support team at <a href="mailto:support@blockdust.xyz">support@blockdust.xyz</a>
              for assistance. We review each case individually.
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
