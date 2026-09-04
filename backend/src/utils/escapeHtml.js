// Escapes text for safe interpolation into HTML (including inside attributes).
// Used wherever untrusted data (scraped post text, case notes, user input) is
// substituted into a template string before being rendered by the browser or
// by Puppeteer for PDF generation.
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

module.exports = { escapeHtml };
