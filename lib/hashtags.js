// "#️⃣ Heshteglar": BITO category hashtags at the end of channel posts (after the phone): the product's
// own category and its main (top) category, e.g. "#Ayollar_sumkasi #Sumkalar". Not in stories.
// Rule: spaces / dashes -> "_", apostrophes and other signs removed, Latin / Cyrillic letters and digits
// kept; at most 2 hashtags, each at most 30 characters; "Kategoriyasiz" (no category) -> none.

import { getAllCategories } from './bito.js';
import { errText, productCategory } from './util.js';

const MAX_TAGS = 2;
const MAX_LEN = 30;

// "Ayollar sumkasi" -> "#Ayollar_sumkasi"; "O‘yinchoq-lar" -> "#Oyinchoq_lar"; nothing usable -> ''.
export function hashtag(name) {
  const body = String(name || '')
    .normalize('NFC')
    .replace(/['ʻʼ‘’`´]/g, '')
    .replace(/[\s\-–—/]+/g, '_')
    .replace(/[^\p{Script=Latin}\p{Script=Cyrillic}\p{N}_]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, MAX_LEN)
    .replace(/_$/, '');
  return /[\p{L}]/u.test(body) ? `#${body}` : '';
}

const NO_CATEGORY = /^(kategoriyasiz|nomsiz|без категории)$/i;

// The tags for a category id with the category list ({ id, name, parent_id }): own, then the top one.
export function tagsFor(catId, list) {
  if (!catId || catId === 'none') return '';
  const byId = new Map(list.map((c) => [String(c.id), c]));
  const own = byId.get(String(catId));
  if (!own || NO_CATEGORY.test(String(own.name).trim())) return '';
  let top = own;
  const seen = new Set([own.id]);
  while (top.parent_id && byId.has(String(top.parent_id)) && !seen.has(String(top.parent_id))) {
    top = byId.get(String(top.parent_id));
    seen.add(top.id);
  }
  const tags = [...new Set([own, top].filter((c) => !NO_CATEGORY.test(String(c.name).trim())).map((c) => hashtag(c.name)).filter(Boolean))];
  return tags.slice(0, MAX_TAGS).join(' ');
}

// The category id of a queue item / product.
export const categoryIdOf = (x) => x?.category_id || productCategory(x || {})?.id || null;

// Sets item.tags for every item (when "#️⃣ Heshteglar" is on). BITO trouble -> no tags, never an error.
export async function addTags(items, s) {
  if (s?.hashtags === false || !items.length) return items;
  let list = null;
  try {
    list = (await getAllCategories()).list;
  } catch (e) {
    console.error(`hashtags: categories not loaded: ${errText(e)}`);
    return items;
  }
  for (const i of items) if (i.tags === undefined) i.tags = tagsFor(categoryIdOf(i), list);
  return items;
}

export const withTags = (caption, tags) => (tags ? `${caption}\n\n${tags}` : caption);
