import React from 'react';
import './SanctionsPage.css';

function SanctionsPage() {
  return (
    <div className="sanctions-page">
      <div className="sanctions-container">
        <div className="sanctions-header">
          <h1>Sanctions & Compliance Screening</h1>
          <p className="subtitle">Our commitment to regulatory compliance and user safety</p>
        </div>

        <div className="sanctions-content">
          <section className="content-section">
            <h2>What is Sanctions Screening?</h2>
            <p>
              BlockDust implements sanctions screening to comply with U.S. and international
              regulations, including OFAC (Office of Foreign Assets Control) requirements.
              This helps ensure our platform is not used for illicit activities or by
              sanctioned entities.
            </p>
          </section>

          <section className="content-section">
            <h2>When Are Checks Performed?</h2>
            <p>We perform sanctions checks at the following touchpoints:</p>
            <ul>
              <li><strong>Wallet Connection:</strong> When you connect your wallet to our platform</li>
              <li><strong>Listing Creation:</strong> Before you can list an NFT for sale</li>
              <li><strong>Purchase:</strong> Before completing a buy transaction</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>What Happens If I'm Blocked?</h2>
            <p>
              If your wallet address appears on a sanctions list, you will see a notification
              and will not be able to proceed with the action. This is an automated process
              designed to protect both you and our platform.
            </p>
            <p>
              <strong>If you believe this is an error:</strong>
            </p>
            <ul>
              <li>Contact our compliance team at <a href="mailto:compliance@blockdust.xyz">compliance@blockdust.xyz</a></li>
              <li>Provide your wallet address and explanation</li>
              <li>We will review your case within 3-5 business days</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>Data Sources</h2>
            <p>
              We use reputable data sources to maintain our sanctions screening lists:
            </p>
            <ul>
              <li>OFAC (Office of Foreign Assets Control) Specially Designated Nationals list</li>
              <li>Third-party blockchain intelligence providers (when enabled)</li>
              <li>Internal risk assessment database</li>
            </ul>
          </section>

          <section className="content-section">
            <h2>Privacy & Data Protection</h2>
            <p>
              All sanctions checks are logged for compliance purposes but are kept confidential.
              We do not share your wallet address or screening results with third parties
              except as required by law or regulation.
            </p>
          </section>

          <section className="content-section">
            <h2>Appeal Process</h2>
            <p>
              If you believe you were incorrectly flagged:
            </p>
            <ol>
              <li>Submit an appeal to <a href="mailto:compliance@blockdust.xyz">compliance@blockdust.xyz</a></li>
              <li>Include your wallet address and supporting documentation</li>
              <li>Our compliance team will review within 3-5 business days</li>
              <li>You'll receive a response via email with next steps</li>
            </ol>
          </section>
        </div>

        <div className="sanctions-footer">
          <div className="footer-card">
            <h3>📋 Regulatory Compliance</h3>
            <p>
              BlockDust is committed to maintaining the highest standards of regulatory
              compliance while providing a seamless user experience.
            </p>
          </div>
          
          <div className="footer-card">
            <h3>🔒 Your Privacy Matters</h3>
            <p>
              We respect your privacy and only collect data necessary for compliance.
              View our full <a href="/privacy">Privacy Policy</a>.
            </p>
          </div>

          <div className="footer-card">
            <h3>📞 Need Help?</h3>
            <p>
              Contact our compliance team:<br />
              <a href="mailto:compliance@blockdust.xyz">compliance@blockdust.xyz</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SanctionsPage;
