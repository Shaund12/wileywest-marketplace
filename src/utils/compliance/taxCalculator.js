/**
 * MA Tax Calculator
 * Handles conditional tax calculation for Massachusetts transactions
 */

/**
 * Calculate MA sales tax on a price
 * @param {string|number} priceWei - Price in wei
 * @param {number} taxRatePercent - Tax rate (e.g., 6.25 for 6.25%)
 * @returns {string} Tax amount in wei
 */
export function calculateTax(priceWei, taxRatePercent = 6.25) {
  if (!priceWei || priceWei === '0') return '0';
  
  try {
    const price = BigInt(priceWei);
    const taxRate = BigInt(Math.floor(taxRatePercent * 100)); // Convert to basis points
    const tax = (price * taxRate) / BigInt(10000);
    return tax.toString();
  } catch (err) {
    console.error('[Tax] Calculation failed:', err);
    return '0';
  }
}

/**
 * Calculate total with tax
 * @param {string|number} priceWei - Price in wei
 * @param {number} taxRatePercent - Tax rate (e.g., 6.25 for 6.25%)
 * @returns {string} Total (price + tax) in wei
 */
export function calculateTotalWithTax(priceWei, taxRatePercent = 6.25) {
  if (!priceWei || priceWei === '0') return '0';
  
  try {
    const price = BigInt(priceWei);
    const tax = BigInt(calculateTax(priceWei, taxRatePercent));
    return (price + tax).toString();
  } catch (err) {
    console.error('[Tax] Total calculation failed:', err);
    return priceWei.toString();
  }
}

/**
 * Check if tax should be applied to a transaction
 * @param {object} params
 * @param {boolean} params.taxSwitchEnabled - Global tax switch
 * @param {boolean} params.isTaxableCollection - Collection marked as taxable
 * @param {number} params.facilitatorGMV - Facilitator GMV in cents
 * @param {number} params.threshold - Threshold in cents (default $100k)
 * @param {string} params.geoMode - 'none' | 'ip' | 'self_declare'
 * @param {boolean} params.isMaBuyer - Whether buyer is in MA (from geo or self-declaration)
 * @returns {boolean}
 */
export function shouldApplyTax({
  taxSwitchEnabled = false,
  isTaxableCollection = false,
  facilitatorGMV = 0,
  threshold = 10000000, // $100k in cents
  geoMode = 'none',
  isMaBuyer = false
}) {
  // If tax switch is off, never apply tax
  if (!taxSwitchEnabled) return false;
  
  // Collection must be marked as taxable
  if (!isTaxableCollection) return false;
  
  // Facilitator GMV must exceed threshold
  if (facilitatorGMV < threshold) return false;
  
  // If geo mode is 'none', we can't determine location, so don't apply tax
  if (geoMode === 'none') return false;
  
  // Buyer must be in MA
  return isMaBuyer;
}

/**
 * Format tax rate for display
 * @param {number} taxRatePercent - Tax rate (e.g., 6.25)
 * @returns {string} Formatted rate (e.g., "6.25%")
 */
export function formatTaxRate(taxRatePercent) {
  return `${taxRatePercent.toFixed(2)}%`;
}

/**
 * Parse tax settings from compliance_settings table
 * @param {object} settings - Row from compliance_settings table
 * @returns {object} Parsed settings
 */
export function parseTaxSettings(settings) {
  if (!settings) {
    return {
      enabled: false,
      thresholdCents: 10000000,
      geoMode: 'none',
      ratePercent: 6.25
    };
  }

  return {
    enabled: settings.tax_switch_enabled || false,
    thresholdCents: settings.facilitator_threshold_cents || 10000000,
    geoMode: settings.tax_geo_mode || 'none',
    ratePercent: parseFloat(settings.tax_rate_ma_percent) || 6.25
  };
}
