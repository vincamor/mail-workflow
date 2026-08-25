/**
 * Supprime le contenu cite (historique des reponses precedentes) du corps d'un mail.
 * Recherche par substring (sans ancrage ^) pour etre robuste aux bodies collapses
 * en une seule ligne (ex: HTML converti sans preservation des \n).
 *
 * NOTE: ce module duplique la logique de stripQuotedText dans
 * src/public/js/aiChat.js (ESM cote frontend). Le frontend conserve sa version
 * pour gerer les anciens JSONL non-strippes (defense-in-depth). Backend = CommonJS.
 *
 * @param {string} body - Corps de mail (text/plain ou stripHtml deja applique).
 * @returns {string} Corps sans citations, trim().
 */
function stripQuotedText(body) {
  if (!body) return '';

  // Patterns detectes n'importe ou dans le texte — on coupe a la premiere occurrence.
  const QUOTE_MARKERS = [
    /Le\s+\S+\s+\d{1,2}\s+\S+\s+\d{4}\s+[àa]\s+\d{1,2}:\d{2}[^]*?a\s+[ée]crit\s*:/i,  // Gmail FR
    /On\s+\w+,?\s+\w+\.?\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i,       // Gmail EN date "On Thu, Sep 19, 2024 at..."
    /On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4}\s+at\s+\d{1,2}:\d{2}[^]*?wrote:/i,               // Gmail EN variant
    /[-_]{3,}\s*(Original|Forwarded|Begin\s+forwarded)\s+message/i,                     // Outlook dividers
    /_{5,}/,                                                                             // Underscore separator
    /From:\s*.+?Sent:\s*.+?To:/is,                                                       // Outlook header block
    /^De\s*:\s*.+<.+@/im,                                                                // Outlook FR "De : ..."
    /^Envoy[ée]\s*:\s*/im,                                                               // Outlook FR "Envoye : ..."
    /^Sent\s*:\s*/im,                                                                    // Outlook EN "Sent: ..."
  ];

  // Cherche la plus ancienne occurrence de citation
  let earliestIndex = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < earliestIndex) {
      earliestIndex = m.index;
    }
  }

  let result = body.slice(0, earliestIndex);

  // Retire aussi les lignes commencant par > (citation classique) presentes avant un marker
  const lines = result.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) break;
    out.push(line);
  }

  return out.join('\n').trim();
}

module.exports = { stripQuotedText };
