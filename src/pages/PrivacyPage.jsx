import React from 'react';

function PrivacyPage() {
  return (
    <div className="privacy-container">
      <div className="page-header">
        <h1>Privacy Policy</h1>
      </div>
      
      <div className="privacy-content">
        <section>
          <h2>1. Information We Collect</h2>
          <p>We collect information when you register on our site, connect your wallet, place an order, or interact with the marketplace. Information may include your wallet address and transaction history on our platform.</p>
        </section>
        
        <section>
          <h2>2. How We Use Your Information</h2>
          <p>We may use the information we collect from you to:</p>
          <ul>
            <li>Process transactions</li>
            <li>Maintain and improve our marketplace</li>
            <li>Personalize your experience</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>
        
        <section>
          <h2>3. Blockchain Data</h2>
          <p>Please be aware that blockchain technology is transparent by design. When you interact with smart contracts and make transactions, information is recorded on a public blockchain and can be viewed by anyone. This includes your wallet address and transaction details.</p>
        </section>
        
        <section>
          <h2>4. Cookies</h2>
          <p>We use cookies to understand and save your preferences for future visits and compile aggregate data about site traffic to offer better site experiences in the future.</p>
        </section>
        
        <section>
          <h2>5. Third-Party Disclosure</h2>
          <p>We do not sell, trade, or otherwise transfer your personally identifiable information to outside parties unless we provide users with advance notice or when required by law.</p>
        </section>
        
        <section>
          <h2>6. Updates to This Policy</h2>
          <p>We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the effective date.</p>
        </section>
      </div>
    </div>
  );
}

export default PrivacyPage;