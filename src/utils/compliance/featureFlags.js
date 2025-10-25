/**
 * Feature Flags for Day-1 Compliance Bundle
 * All flags default to OFF for zero-downtime deployment
 */

export const FLAGS = {
  DMCA: import.meta.env.VITE_FLAG_DMCA === '1',
  WISP: import.meta.env.VITE_FLAG_WISP === '1',
  SANCTIONS: import.meta.env.VITE_FLAG_SANCTIONS === '1',
  TAX_SWITCH: import.meta.env.VITE_FLAG_TAX_SWITCH === '1',
};

export const COMPLIANCE_CONFIG = {
  ofacProvider: import.meta.env.VITE_OFAC_PROVIDER || 'local',
  taxGeoMode: import.meta.env.VITE_TAX_GEO_MODE || 'none',
  dmcaAgentEmail: import.meta.env.VITE_DMCA_AGENT_EMAIL || 'legal@blockdust.xyz',
};

/**
 * Check if any compliance feature is enabled
 */
export const isAnyComplianceFeatureEnabled = () => {
  return Object.values(FLAGS).some(flag => flag === true);
};

/**
 * Get all enabled features
 */
export const getEnabledFeatures = () => {
  return Object.entries(FLAGS)
    .filter(([_, enabled]) => enabled)
    .map(([name, _]) => name);
};
