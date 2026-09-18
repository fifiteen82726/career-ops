// This function is serialized by the installed Playwright bridge. Keep all
// helpers inside it and return compact card fields only.
export function extractConnectionCards(documentOrOptions, maybeOptions = {}) {
  const doc = documentOrOptions?.querySelectorAll ? documentOrOptions : globalThis.document;
  const options = doc === documentOrOptions ? maybeOptions : documentOrOptions || {};
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const href = String(doc?.location?.href || '');
  const bad = /\/(?:login|uas\/login)(?:[/?#]|$)/i.test(href) || doc?.querySelector?.('input[type="password"], form[action*="login"]');
  if (bad) return { sourceStatus: 'linkedin_not_authenticated', cards: [] };
  const challengeNode = doc?.querySelector?.('[role="dialog"], [class*="challenge" i], [class*="captcha" i], [data-test-id*="verification" i]');
  // Only inspect semantic headings, never page text or a DOM archive.  LinkedIn
  // sometimes renders an identity checkpoint as ordinary main-page markup.
  // A checkpoint is sometimes rendered as ordinary, direct main-area notice
  // text rather than a dialog or heading.  Inspect only semantic notice
  // elements, never whole-page text or an exported DOM.
  const challengeHeading = [...doc?.querySelectorAll?.('main h1, main h2, main p, main [role="alert"], [role="main"] h1, [role="main"] h2, [role="main"] p, [role="main"] [role="alert"], [role="heading"]') || []]
    .find(node => /(?:security check|verify your identity|confirm your identity|captcha|one-time code)/i.test(compact(node.textContent)));
  if (/(?:checkpoint|challenge|captcha|security|verify|two-step|otp)/i.test(href) || doc?.querySelector?.('input[autocomplete="one-time-code"], input[type="email"], input[type="tel"]') || (challengeNode && /(?:security check|verify your identity|confirm your identity|captcha|one-time code)/i.test(compact(challengeNode.textContent))) || challengeHeading) return { sourceStatus: 'linkedin_challenge', cards: [] };
  if (!/^https:\/\/www\.linkedin\.com\/mynetwork\/invite-connect\/connections\/$/i.test(href)) return { sourceStatus: 'partial', cards: [] };
  const main = doc?.querySelector?.('main, [role="main"]'); const visible = node => { for(let p=node;p;p=p.parentElement) { if(p.hidden || p.getAttribute?.('aria-hidden') === 'true') return false; const s=globalThis.getComputedStyle?.(p); if(s && (s.display==='none'||s.visibility==='hidden'||s.opacity==='0')) return false; } return true; };
  if (!main || !visible(main) || doc?.querySelector?.('[aria-busy="true"], [data-test-id*="loading" i], .artdeco-loader')) return { sourceStatus: 'partial', cards: [] };
  const list=[...main.querySelectorAll?.('[role="list"]')||[]].find(node=>{
    if (!visible(node) || !node.querySelector?.(':scope > [role="listitem"] a[href*="/in/"]')) return false;
    const label=compact(`${node.getAttribute?.('aria-label')||''} ${node.closest?.('[aria-label]')?.getAttribute?.('aria-label')||''}`);
    // A nearby Suggested/People-you-may-know list has structurally identical
    // cards.  Only the explicitly labelled Connections collection is trusted.
    return /\bconnections\b/i.test(label) && !/(?:suggested|people you may know)/i.test(label);
  });
  if (!list || list.closest?.('aside, nav, [role="complementary"]')) return { sourceStatus: 'partial', cards: [] };
  // "Recently added" is trusted only when the chosen control is explicitly
  // tied to this exact Connections list.  A selected control in Suggestions
  // is not ordering evidence for the collection we are about to capture.
  const selectedOrder=[...doc.querySelectorAll?.('[aria-current="true"], [aria-selected="true"]')||[]].find(node=>{
    if (!visible(node) || node.closest?.('main, [role="main"]') !== main || !/recently added/i.test(compact(node.textContent))) return false;
    const controls = (node.getAttribute?.('aria-controls') || '').trim().split(/\s+/).filter(Boolean);
    if (list.id && controls.includes(list.id)) return true;
    // An explicit relationship to another collection is a contradiction. A
    // shared ancestor is not evidence that this control orders this list.
    if (controls.length) return false;
    const labelled = (list.getAttribute?.('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (node.id && labelled.includes(node.id)) return true;
    return false;
  });
  if (!selectedOrder) return { sourceStatus: 'partial', cards: [] };
  const cards = []; const seen = new Set(); const limit = Math.min(50, Math.max(0, Number(options.limit) || 50));
  for (const card of [...list.querySelectorAll?.(':scope > [role="listitem"]') || []]) {
    if (cards.length >= limit) break; if (!visible(card) || card.parentElement !== list || !list.contains?.(card)) continue;
    // A card is a principal identity boundary. Repeated links to one profile
    // are harmless; two distinct profiles in one card make field ownership
    // ambiguous, so fail closed instead of emitting either identity.
    const principals = new Set(); let anchor = null;
    for (const link of [...card.querySelectorAll?.('a[href*="/in/"]') || []]) {
      if (!visible(link) || link.closest?.('[role="listitem"]') !== card) continue;
      try { const url = new URL(link.href || link.getAttribute?.('href'), 'https://www.linkedin.com'); if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || url.username || url.password || url.port || !/^\/in\/[^/?#]+\/?$/.test(url.pathname) || /%(?![0-9a-f]{2})/i.test(url.pathname)) continue; const slug = decodeURIComponent(url.pathname.slice(4).replace(/\/$/, '')); if (!slug || /[\\/\u0000-\u001f]/.test(slug)) continue; principals.add(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`); anchor ||= link; } catch { /* unsafe link */ }
    }
    if (principals.size !== 1) continue; const profileUrl = [...principals][0];
    if (seen.has(profileUrl) || !anchor) continue;
    // Ancestor divs concatenate names/headlines/labels; accepting their text
    // would manufacture a headline from a nested card.  Use visible leaves.
    const fields = [...card.querySelectorAll?.('span,p,time,div') || []].filter(node => visible(node) && node.closest?.('[role="listitem"]') === card && !node.querySelector?.('span,p,time,div')).map(node => compact(node.textContent)).filter(Boolean).slice(0, 24);
    const fullName = compact(anchor.textContent).slice(0, 300); const connectedLabelRaw = fields.find(value => /^connected\s+(?:on\s+)?(?:yesterday|\d+\s+(?:days?|weeks?)\s+ago|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})$/i.test(value)); const headline = fields.find(value => value !== fullName && value !== connectedLabelRaw && !/^connected\b/i.test(value) && value.length <= 500) || '';
    if (!fullName || !connectedLabelRaw) continue; cards.push({ profileUrl, fullName, headline, connectedLabelRaw }); seen.add(profileUrl);
  }
  return { sourceStatus: cards.length ? 'ok' : 'partial', cards };
}
