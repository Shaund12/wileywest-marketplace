import React, { useState } from 'react';
import { useSupabase } from '../../context/SupabaseContext';
import { toast } from 'sonner';
import './DMCAPage.css';

function DMCAPage() {
  const { supabase } = useSupabase();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    complainantName: '',
    complainantEmail: '',
    rightsHolder: '',
    infringingUrls: '',
    originalWorkUrls: '',
    evidenceUrls: '',
    swornStatement: '',
    signature: ''
  });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Validate required fields
      if (!formData.complainantName || !formData.complainantEmail) {
        toast.error('Please fill in all required fields');
        setLoading(false);
        return;
      }

      if (!formData.infringingUrls || !formData.originalWorkUrls) {
        toast.error('Please provide both infringing and original work URLs');
        setLoading(false);
        return;
      }

      if (!formData.swornStatement || !formData.signature) {
        toast.error('Please complete the sworn statement and signature');
        setLoading(false);
        return;
      }

      // Call RPC function
      const { data, error } = await supabase.rpc('rpc_dmca_create', {
        payload: {
          complainant_name: formData.complainantName,
          complainant_email: formData.complainantEmail,
          rights_holder: formData.rightsHolder || null,
          infringing_urls: formData.infringingUrls,
          original_work_urls: formData.originalWorkUrls,
          evidence_urls: formData.evidenceUrls || '',
          sworn_statement: formData.swornStatement,
          signature: formData.signature,
          ip: null, // Could be populated from a backend service
          user_agent: navigator.userAgent
        }
      });

      if (error) throw error;

      toast.success('DMCA takedown notice submitted successfully. Reference ID: ' + data);
      
      // Reset form
      setFormData({
        complainantName: '',
        complainantEmail: '',
        rightsHolder: '',
        infringingUrls: '',
        originalWorkUrls: '',
        evidenceUrls: '',
        swornStatement: '',
        signature: ''
      });
    } catch (error) {
      console.error('[DMCA] Submission failed:', error);
      toast.error('Failed to submit DMCA notice: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dmca-page">
      <div className="dmca-container">
        <div className="dmca-header">
          <h1>DMCA Takedown Notice</h1>
          <p className="dmca-subtitle">
            Submit a Digital Millennium Copyright Act (DMCA) takedown request
          </p>
        </div>

        <div className="dmca-notice">
          <h3>⚠️ Important Information</h3>
          <ul>
            <li>False claims may subject you to liability for damages, including costs and attorney fees</li>
            <li>You must be the copyright owner or authorized to act on their behalf</li>
            <li>Please provide accurate and complete information</li>
            <li>We will review your request and take appropriate action within 24-48 hours</li>
          </ul>
        </div>

        <form className="dmca-form" onSubmit={handleSubmit}>
          <div className="form-section">
            <h2>1. Your Information</h2>
            
            <div className="form-group">
              <label htmlFor="complainantName">
                Your Full Name <span className="required">*</span>
              </label>
              <input
                type="text"
                id="complainantName"
                name="complainantName"
                value={formData.complainantName}
                onChange={handleChange}
                required
                placeholder="John Doe"
              />
            </div>

            <div className="form-group">
              <label htmlFor="complainantEmail">
                Your Email Address <span className="required">*</span>
              </label>
              <input
                type="email"
                id="complainantEmail"
                name="complainantEmail"
                value={formData.complainantEmail}
                onChange={handleChange}
                required
                placeholder="your.email@example.com"
              />
            </div>

            <div className="form-group">
              <label htmlFor="rightsHolder">
                Rights Holder (if different from you)
              </label>
              <input
                type="text"
                id="rightsHolder"
                name="rightsHolder"
                value={formData.rightsHolder}
                onChange={handleChange}
                placeholder="Company Name or Individual"
              />
            </div>
          </div>

          <div className="form-section">
            <h2>2. Infringing Content</h2>
            
            <div className="form-group">
              <label htmlFor="infringingUrls">
                URLs of Infringing Content <span className="required">*</span>
              </label>
              <textarea
                id="infringingUrls"
                name="infringingUrls"
                value={formData.infringingUrls}
                onChange={handleChange}
                required
                rows="4"
                placeholder="https://blockdust.xyz/nft/0x.../123&#10;https://blockdust.xyz/nft/0x.../456"
              />
              <small>Enter one URL per line or separate with commas</small>
            </div>

            <div className="form-group">
              <label htmlFor="originalWorkUrls">
                URLs of Original Work <span className="required">*</span>
              </label>
              <textarea
                id="originalWorkUrls"
                name="originalWorkUrls"
                value={formData.originalWorkUrls}
                onChange={handleChange}
                required
                rows="4"
                placeholder="https://yourwebsite.com/original-artwork&#10;https://instagram.com/yourhandle/post/..."
              />
              <small>Where can we verify your original work?</small>
            </div>

            <div className="form-group">
              <label htmlFor="evidenceUrls">
                Supporting Evidence URLs (optional)
              </label>
              <textarea
                id="evidenceUrls"
                name="evidenceUrls"
                value={formData.evidenceUrls}
                onChange={handleChange}
                rows="3"
                placeholder="https://copyright.gov/registration/...&#10;Additional proof links..."
              />
              <small>Copyright registrations, timestamps, etc.</small>
            </div>
          </div>

          <div className="form-section">
            <h2>3. Sworn Statement</h2>
            
            <div className="form-group">
              <label htmlFor="swornStatement">
                Statement <span className="required">*</span>
              </label>
              <textarea
                id="swornStatement"
                name="swornStatement"
                value={formData.swornStatement}
                onChange={handleChange}
                required
                rows="6"
                placeholder="I hereby state that I have a good faith belief that the use of the copyrighted material described above is not authorized by the copyright owner, its agent, or the law..."
              />
              <small>
                You must state: (1) good faith belief the use is unauthorized, 
                (2) the information is accurate, and (3) under penalty of perjury, 
                you are authorized to act on behalf of the copyright owner
              </small>
            </div>

            <div className="form-group">
              <label htmlFor="signature">
                Electronic Signature <span className="required">*</span>
              </label>
              <input
                type="text"
                id="signature"
                name="signature"
                value={formData.signature}
                onChange={handleChange}
                required
                placeholder="Type your full name as signature"
              />
              <small>By typing your name, you agree this serves as your legal signature</small>
            </div>
          </div>

          <div className="form-actions">
            <button 
              type="submit" 
              className="btn-submit"
              disabled={loading}
            >
              {loading ? 'Submitting...' : 'Submit DMCA Notice'}
            </button>
          </div>
        </form>

        <div className="dmca-footer">
          <p>
            <strong>Questions?</strong> Contact our DMCA agent at{' '}
            <a href={`mailto:${import.meta.env.VITE_DMCA_AGENT_EMAIL || 'legal@blockdust.xyz'}`}>
              {import.meta.env.VITE_DMCA_AGENT_EMAIL || 'legal@blockdust.xyz'}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default DMCAPage;
