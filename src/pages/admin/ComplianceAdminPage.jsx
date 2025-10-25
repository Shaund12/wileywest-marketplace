import React, { useState, useEffect } from 'react';
import { useSupabase } from '../../context/SupabaseContext';
import { toast } from 'sonner';
import { parseTaxSettings, formatTaxRate } from '../../utils/compliance/taxCalculator';
import './ComplianceAdminPage.css';

function ComplianceAdminPage() {
  const { supabase } = useSupabase();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [gmvData, setGmvData] = useState(null);
  const [activeTab, setActiveTab] = useState('general');

  useEffect(() => {
    loadSettings();
    loadGMVData();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('compliance_settings')
        .select('*')
        .eq('id', 1)
        .single();

      if (error) throw error;

      setSettings(data);
    } catch (error) {
      console.error('[Compliance Admin] Failed to load settings:', error);
      toast.error('Failed to load compliance settings');
    } finally {
      setLoading(false);
    }
  };

  const loadGMVData = async () => {
    try {
      // Refresh the materialized view first
      await supabase.rpc('refresh_ma_gmv');

      const { data, error } = await supabase
        .from('ma_gmv_trailing_365')
        .select('*')
        .single();

      if (error && error.code !== 'PGRST116') { // Ignore "no rows" error
        throw error;
      }

      setGmvData(data);
    } catch (error) {
      console.error('[Compliance Admin] Failed to load GMV:', error);
    }
  };

  const updateSettings = async (updates) => {
    try {
      const { error } = await supabase
        .from('compliance_settings')
        .update(updates)
        .eq('id', 1);

      if (error) throw error;

      toast.success('Settings updated successfully');
      loadSettings();
    } catch (error) {
      console.error('[Compliance Admin] Failed to update settings:', error);
      toast.error('Failed to update settings');
    }
  };

  const toggleTaxSwitch = async () => {
    await updateSettings({
      tax_switch_enabled: !settings?.tax_switch_enabled
    });
  };

  const updateTaxGeoMode = async (mode) => {
    await updateSettings({ tax_geo_mode: mode });
  };

  const updateDMCAEmail = async (email) => {
    await updateSettings({ dmca_agent_email: email });
  };

  if (loading) {
    return (
      <div className="compliance-admin-page">
        <div className="loading">Loading compliance settings...</div>
      </div>
    );
  }

  const taxSettings = parseTaxSettings(settings);
  const gmvVtru = gmvData?.gmv_vtru || 0;
  const gmvUsd = gmvVtru * 0.50; // Rough estimate; in production use real price
  const thresholdUsd = taxSettings.thresholdCents / 100;
  const aboveThreshold = gmvUsd >= thresholdUsd;

  return (
    <div className="compliance-admin-page">
      <div className="compliance-admin-container">
        <div className="page-header">
          <h1>Compliance Administration</h1>
          <p className="subtitle">Manage compliance settings and feature flags</p>
        </div>

        <div className="tabs">
          <button
            className={activeTab === 'general' ? 'tab active' : 'tab'}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={activeTab === 'tax' ? 'tab active' : 'tab'}
            onClick={() => setActiveTab('tax')}
          >
            Tax Settings
          </button>
          <button
            className={activeTab === 'dmca' ? 'tab active' : 'tab'}
            onClick={() => setActiveTab('dmca')}
          >
            DMCA
          </button>
        </div>

        <div className="tab-content">
          {activeTab === 'general' && (
            <div className="settings-section">
              <h2>General Settings</h2>
              
              <div className="setting-card">
                <div className="setting-info">
                  <h3>Feature Flags Status</h3>
                  <p>Current environment configuration</p>
                </div>
                <div className="flag-grid">
                  <div className="flag-item">
                    <span className="flag-name">DMCA</span>
                    <span className={`flag-status ${import.meta.env.VITE_FLAG_DMCA === '1' ? 'enabled' : 'disabled'}`}>
                      {import.meta.env.VITE_FLAG_DMCA === '1' ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flag-item">
                    <span className="flag-name">WISP</span>
                    <span className={`flag-status ${import.meta.env.VITE_FLAG_WISP === '1' ? 'enabled' : 'disabled'}`}>
                      {import.meta.env.VITE_FLAG_WISP === '1' ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flag-item">
                    <span className="flag-name">Sanctions</span>
                    <span className={`flag-status ${import.meta.env.VITE_FLAG_SANCTIONS === '1' ? 'enabled' : 'disabled'}`}>
                      {import.meta.env.VITE_FLAG_SANCTIONS === '1' ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flag-item">
                    <span className="flag-name">Tax Switch</span>
                    <span className={`flag-status ${import.meta.env.VITE_FLAG_TAX_SWITCH === '1' ? 'enabled' : 'disabled'}`}>
                      {import.meta.env.VITE_FLAG_TAX_SWITCH === '1' ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                </div>
                <p className="note">
                  Note: Feature flags are controlled via environment variables and require a redeploy to change.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'tax' && (
            <div className="settings-section">
              <h2>Tax Settings</h2>

              <div className="setting-card">
                <div className="setting-header">
                  <div className="setting-info">
                    <h3>Tax Collection Switch</h3>
                    <p>Enable or disable MA sales tax collection</p>
                  </div>
                  <button
                    className={`toggle-btn ${taxSettings.enabled ? 'enabled' : 'disabled'}`}
                    onClick={toggleTaxSwitch}
                  >
                    {taxSettings.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </div>

              <div className="setting-card">
                <div className="setting-info">
                  <h3>GMV Tracking (Trailing 365 Days)</h3>
                  <p>Monitor facilitator GMV for threshold compliance</p>
                </div>
                <div className="gmv-stats">
                  <div className="stat">
                    <span className="stat-label">Total GMV (VTRU):</span>
                    <span className="stat-value">{gmvVtru.toFixed(2)} VTRU</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Estimated GMV (USD):</span>
                    <span className="stat-value">${gmvUsd.toLocaleString()}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">MA Threshold:</span>
                    <span className="stat-value">${thresholdUsd.toLocaleString()}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Status:</span>
                    <span className={`stat-value ${aboveThreshold ? 'above' : 'below'}`}>
                      {aboveThreshold ? 'Above Threshold' : 'Below Threshold'}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Trades Count:</span>
                    <span className="stat-value">{gmvData?.trades_count || 0}</span>
                  </div>
                </div>
                <button className="btn-refresh" onClick={loadGMVData}>
                  Refresh GMV Data
                </button>
              </div>

              <div className="setting-card">
                <div className="setting-info">
                  <h3>Tax Rate</h3>
                  <p>Massachusetts sales tax rate</p>
                </div>
                <div className="setting-value">
                  {formatTaxRate(taxSettings.ratePercent)}
                </div>
              </div>

              <div className="setting-card">
                <div className="setting-info">
                  <h3>Geo Location Mode</h3>
                  <p>How to determine buyer location</p>
                </div>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      name="geoMode"
                      value="none"
                      checked={taxSettings.geoMode === 'none'}
                      onChange={(e) => updateTaxGeoMode(e.target.value)}
                    />
                    <span>None (No location tracking)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="geoMode"
                      value="ip"
                      checked={taxSettings.geoMode === 'ip'}
                      onChange={(e) => updateTaxGeoMode(e.target.value)}
                    />
                    <span>IP-based (Automatic)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="geoMode"
                      value="self_declare"
                      checked={taxSettings.geoMode === 'self_declare'}
                      onChange={(e) => updateTaxGeoMode(e.target.value)}
                    />
                    <span>Self-declaration (User selects)</span>
                  </label>
                </div>
              </div>

              <div className="info-box">
                <h4>Tax Application Logic</h4>
                <p>Tax will be applied when <strong>ALL</strong> of these conditions are met:</p>
                <ol>
                  <li>Tax switch is <strong>enabled</strong></li>
                  <li>Collection is marked as <strong>taxable</strong></li>
                  <li>GMV exceeds <strong>${thresholdUsd.toLocaleString()}</strong> threshold</li>
                  <li>Buyer is in <strong>Massachusetts</strong></li>
                  <li>Geo mode is <strong>not "none"</strong></li>
                </ol>
              </div>
            </div>
          )}

          {activeTab === 'dmca' && (
            <div className="settings-section">
              <h2>DMCA Settings</h2>

              <div className="setting-card">
                <div className="setting-info">
                  <h3>DMCA Agent Email</h3>
                  <p>Email address for DMCA takedown notifications</p>
                </div>
                <input
                  type="email"
                  className="input-field"
                  value={settings?.dmca_agent_email || ''}
                  onChange={(e) => {
                    setSettings({ ...settings, dmca_agent_email: e.target.value });
                  }}
                  onBlur={(e) => updateDMCAEmail(e.target.value)}
                  placeholder="legal@blockdust.xyz"
                />
              </div>

              <div className="info-box">
                <h4>DMCA Management</h4>
                <p>
                  To review and manage DMCA takedown requests, visit the{' '}
                  <a href="/admin/dmca">DMCA Admin Page</a>.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ComplianceAdminPage;
