import React, { useState, useEffect } from 'react';
import { useSupabase } from '../../context/SupabaseContext';
import { toast } from 'sonner';
import './WISPPage.css';

// Default WISP content that doesn't require database
const DEFAULT_WISP_CONTENT = `# BlockDust Written Information Security Program

## 1. Introduction

BlockDust maintains this Written Information Security Program (WISP) to protect sensitive user data and comply with applicable regulations.

## 2. Data We Collect

- Wallet addresses (public blockchain data)
- Transaction history (on-chain data)
- Optional: Email addresses for notifications
- IP addresses for security purposes

## 3. Security Measures

### Technical Safeguards
- End-to-end encryption for sensitive communications
- Secure API endpoints with rate limiting
- Regular security audits and penetration testing
- Multi-factor authentication for admin access

### Administrative Safeguards
- Employee security training
- Access control policies
- Incident response procedures
- Regular policy reviews

### Physical Safeguards
- Cloud infrastructure with SOC 2 compliance
- Encrypted data at rest and in transit
- Redundant backups

## 4. Data Retention

- Transaction data: Retained indefinitely (blockchain immutability)
- User preferences: Retained while account is active
- Logs: Retained for 90 days

## 5. Third-Party Services

- Supabase: Database and authentication
- Vercel: Hosting and edge functions
- Vitruveo: Blockchain network

## 6. Incident Response

In the event of a security incident:
1. Immediate containment and assessment
2. User notification within 72 hours
3. Investigation and remediation
4. Post-incident review

## 7. Contact

For security concerns: security@blockdust.xyz

**Last Updated:** January 2025
**Version:** 1.0`;

function WISPPage() {
  const { supabase, isConnected } = useSupabase();
  const [content, setContent] = useState(DEFAULT_WISP_CONTENT);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);

  useEffect(() => {
    loadWISPContent();
  }, []);

  const loadWISPContent = async () => {
    setLoading(true);
    try {
      // If Supabase is not connected, use default content
      if (!supabase || !isConnected) {
        console.log('[WISP] Using default content (Supabase not configured)');
        setContent(DEFAULT_WISP_CONTENT);
        setUsingFallback(true);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('legal_docs')
        .select('*')
        .eq('slug', 'wisp')
        .single();

      if (error) {
        console.warn('[WISP] Database error, using default content:', error.message);
        setContent(DEFAULT_WISP_CONTENT);
        setUsingFallback(true);
      } else {
        setContent(data?.content_md || DEFAULT_WISP_CONTENT);
        setUsingFallback(false);
      }
    } catch (error) {
      console.error('[WISP] Failed to load:', error);
      setContent(DEFAULT_WISP_CONTENT);
      setUsingFallback(true);
    } finally {
      setLoading(false);
    }
  };

  const downloadPDF = async () => {
    setDownloading(true);
    try {
      // In a real implementation, this would call a server endpoint
      // that generates a PDF from the markdown content
      // For now, we'll create a simple text file download
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `BlockDust-WISP-${new Date().toISOString().split('T')[0]}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success('WISP document downloaded');
    } catch (error) {
      console.error('[WISP] Download failed:', error);
      toast.error('Failed to download WISP document');
    } finally {
      setDownloading(false);
    }
  };

  const renderMarkdown = (markdown) => {
    // Simple markdown renderer for display
    return markdown
      .split('\n')
      .map((line, idx) => {
        if (line.startsWith('# ')) {
          return <h1 key={idx}>{line.substring(2)}</h1>;
        } else if (line.startsWith('## ')) {
          return <h2 key={idx}>{line.substring(3)}</h2>;
        } else if (line.startsWith('### ')) {
          return <h3 key={idx}>{line.substring(4)}</h3>;
        } else if (line.startsWith('- ')) {
          return <li key={idx}>{line.substring(2)}</li>;
        } else if (line.trim() === '') {
          return <br key={idx} />;
        } else if (line.startsWith('**') && line.endsWith('**')) {
          return <p key={idx}><strong>{line.slice(2, -2)}</strong></p>;
        } else {
          return <p key={idx}>{line}</p>;
        }
      });
  };

  return (
    <div className="wisp-page">
      <div className="wisp-container">
        <div className="wisp-header">
          <h1>Written Information Security Program (WISP)</h1>
          <button 
            className="btn-download"
            onClick={downloadPDF}
            disabled={downloading || loading}
          >
            {downloading ? 'Downloading...' : 'Download Document'}
          </button>
        </div>

        {usingFallback && (
          <div className="wisp-notice" style={{
            background: 'rgba(255, 170, 51, 0.1)',
            border: '1px solid rgba(255, 170, 51, 0.3)',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1.5rem'
          }}>
            <p style={{ color: 'rgba(255, 255, 255, 0.9)', margin: 0 }}>
              📄 Displaying default WISP document. For the latest version, ensure Supabase is configured.
            </p>
          </div>
        )}

        {loading ? (
          <div className="loading">Loading WISP document...</div>
        ) : (
          <div className="wisp-content">
            {renderMarkdown(content)}
          </div>
        )}

        <div className="wisp-footer">
          <p>
            <strong>Questions about our security practices?</strong> Contact us at{' '}
            <a href="mailto:security@blockdust.xyz">security@blockdust.xyz</a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default WISPPage;
