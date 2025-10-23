import React, { useState, useEffect } from 'react';
import { useSupabase } from '../../context/SupabaseContext';
import { toast } from 'sonner';
import './WISPPage.css';

function WISPPage() {
  const { supabase } = useSupabase();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    loadWISPContent();
  }, []);

  const loadWISPContent = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('legal_docs')
        .select('*')
        .eq('slug', 'wisp')
        .single();

      if (error) throw error;

      setContent(data?.content_md || '# WISP Document Not Found');
    } catch (error) {
      console.error('[WISP] Failed to load:', error);
      setContent('# Error Loading WISP\n\nPlease contact support.');
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
