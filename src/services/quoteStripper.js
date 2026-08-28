/**
 * Removes quoted content (history of previous replies) from email body.
 * Searches by substring (without ^ anchor) to be robust to bodies collapsed
 * into a single line (e.g. HTML converted without \n preservation).
 *
 * NOTE: this module duplicates the stripQuotedText logic in
 * src/public/js/aiChat.js (ESM on frontend). Frontend keeps its version
 * to handle old non-stripped JSONL (defense-in-depth). Backend = CommonJS.
 *
 * @param {string} body - Email body (text/plain or stripHtml already applied).
 * @returns {string} Body without quotes, trimmed.
 */
function stripQuotedText(body) {
  if (!body) return '';

  // Patterns detected anywhere in text — cut at first occurrence.
  const QUOTE_MARKERS = [
    /Le\s+\S+\s+\d{1,2}\s+\S+\s+\d{4}\s+[àa]\s+\d{1,2}:\d{2}[^]*?a\s+[ée]crit\s*:/i, // Gmail FR
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i, // Gmail EN date "On Thu, Sep 19, 2024 at..."
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i, // Gmail EN variant
    /[-_]{3,}\s*(Original|Forwarded|Begin\s+forwarded)\s+message/i, // Outlook dividers
    /_{5,}/, // Underscore separator
    /From:\s*.+?Sent:\s*.+?To:/is, // Outlook header block
    /^De\s*:\s*.+<.+@/im, // Outlook FR "De : ..."
    /^Envoy[ée]\s*:\s*/im, // Outlook FR "Sent : ..."
    /^Sent\s*:\s*/im, // Outlook EN "Sent: ..."
  ];

  // Find earliest occurrence of quote
  let earliestIndex = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < earliestIndex) {
      earliestIndex = m.index;
    }
  }

  const result = body.slice(0, earliestIndex);

  // Also remove lines starting with > (classic quote) present before a marker
  const lines = result.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) break;
    out.push(line);
  }

  return out.join('\n').trim();
}

module.exports = { stripQuotedText };
