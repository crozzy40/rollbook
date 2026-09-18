'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, opts = {}) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (opts.plain) return (v < 0 ? '-' : '') + '$' + s;
  return (v < 0 ? '−' : '') + '$' + s;
}
function money0(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function dateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function dateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Chart of accounts. Order matters: this is how the expense report and the year-end summary sort.
const CATEGORIES = [
  'Mortgage',
  'Property tax',
  'Insurance',
  'Utilities',
  'Repairs & maintenance',
  'Capital improvements',
  'Supplies',
  'Cleaning',
  'Legal & professional',
  'Management & admin',
  'Advertising',
  'Other',
];

// Map a line from her template (category label + item name) onto the chart of accounts.
function categorizeLine(category, item) {
  const it = String(item || '').toLowerCase();
  if (/mortgage|loan/.test(it)) return 'Mortgage';
  if (/property tax|tax/.test(it)) return 'Property tax';
  if (/insurance/.test(it)) return 'Insurance';
  if (/gas|electric|water|sewer|waste|trash|garbage|internet|utility/.test(it)) return 'Utilities';
  if (/lawyer|legal|account|cpa|attorney|architect|engineer|inspection/.test(it)) return 'Legal & professional';
  if (/clean|maid|janitor/.test(it)) return 'Cleaning';
  if (/listing|advert|zillow|marketing/.test(it)) return 'Advertising';
  if (/admin|management|software|bank fee/.test(it)) return 'Management & admin';
  if (/supplies/.test(it)) return 'Supplies';
  const cat = String(category || '').toLowerCase();
  if (/repair|maint/.test(cat)) return 'Repairs & maintenance';
  if (/util/.test(cat)) return 'Utilities';
  if (/legal/.test(cat)) return 'Legal & professional';
  if (/equipment|capital/.test(cat)) return 'Capital improvements';
  return 'Other';
}

// Guess a category for a receipt-log line from its description and size.
function categorizeReceipt(description, amount) {
  const d = String(description || '').toLowerCase();
  const big = Number(amount) >= 1000;
  if (/architect|engineer|permit|inspection|lawyer|legal|accountant/.test(d)) return 'Legal & professional';
  if (/maid|clean/.test(d)) return 'Cleaning';
  if (/^food|lunch|dinner|coffee|meal/.test(d)) return 'Other';
  if (/usps|postage|stamp|fedex|ups\b/.test(d)) return 'Management & admin';
  if (/fridge|refrigerator|stove|oven|range|washer|dryer|dishwasher|appliance|air condition|a\/c|ac unit|hvac|furnace|boiler|water heater|sprinkler|meter|roof|window|floor(?!\s*paper)|whole building|sewer line|main line|driveway|fence/.test(d)) {
    return big ? 'Capital improvements' : 'Repairs & maintenance';
  }
  if (/plumb|electric|hvac|repair|fix|contractor|handyman|drywall|paint|carpenter|roofer/.test(d)) return big ? 'Capital improvements' : 'Repairs & maintenance';
  if (/^gas$|fuel|propane|mapp/.test(d)) return 'Supplies';
  return 'Supplies';
}

const PAYMENT_METHODS = ['Cash', 'Check', 'Zelle', 'Venmo', 'Bank transfer', 'Card', 'RentRedi', 'Money order', 'Other'];
const UNIT_KINDS = ['apartment', 'garage', 'parking', 'storage', 'other'];

module.exports = { esc, money, money0, dateLong, dateShort, CATEGORIES, categorizeLine, categorizeReceipt, PAYMENT_METHODS, UNIT_KINDS };
