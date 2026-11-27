// Pulls BluJ TCG listings from eBay, sorts them into zones, and writes dist/index.html + dist/catalog.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const ID = process.env.EBAY_CLIENT_ID;
const SECRET = process.env.EBAY_CLIENT_SECRET;
const SELLER = process.env.EBAY_SELLER || 'bluj_tcg';
if (!ID || !SECRET) throw new Error('Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET');

// By default EVERY card in the category shows (Pokemon, Magic, One Piece, etc.).
// Set POKEMON_ONLY=1 to hide other card games using the keyword list below.
const POKEMON_ONLY = process.env.POKEMON_ONLY === '1';
const NON_POKEMON = /Magic:? The Gathering|\bMTG\b|Naruto|Kayou|Yu-?gi-?oh|Riftbound|Dragon Ball|\bDBS\b|Teenage Mutant|Spider-Man|Marvel|Hobbit|One Piece|Saikyo Jump|Gundam|Lorcana|Digimon|Union Arena/i;
const GRADE = /\b(PSA|BGS|CGC|TAG|SGC|ACE)\s*(\d+(?:\.\d)?)/i;
const TITLE_COND = /Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|\b(?:NM|LP|MP|HP)\b/;
const SPELL = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played' };

async function getToken() {
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!r.ok) throw new Error(`Token request failed: ${r.status}`);
  return (await r.json()).access_token;
}

async function pullAll(token) {
  const items = new Map();
  let offset = 0, total = Infinity;
  while (offset < total && offset < 10000) {
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?category_ids=2536&filter=sellers:%7B${SELLER}%7D&limit=200&offset=${offset}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    if (!r.ok) throw new Error(`Search failed at offset ${offset}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    total = j.total ?? 0;
    const list = j.itemSummaries ?? [];
    if (!list.length) break;
    for (const i of list) items.set(i.itemId, i);
    offset += 200;
  }
  return { list: [...items.values()], total };
}

function toCard(i) {
  const name = i.title || '';
  if (POKEMON_ONLY && NON_POKEMON.test(name)) return null;
  const price = Number(i.price?.value);
  if (!Number.isFinite(price)) return null;
  const graded = i.condition === 'Graded';
  const zone = graded ? 'slabs' : i.conditionId === '1000' ? 'sealed' : price < 3 ? 'binders' : 'singles';
  let condition = i.condition;
  if (graded) {
    const g = name.match(GRADE);
    condition = g ? `${g[1].toUpperCase()} ${g[2]}` : 'Graded';
  } else {
    const m = name.match(TITLE_COND);
    if (m) condition = SPELL[m[0]] || m[0];
  }
  const id = i.legacyItemId || String(i.itemId).split('|')[1];
  const small = i.image?.imageUrl || '';
  return {
    id, zone, name, condition, price,
    image: small.replace(/s-l\d+/, 's-l500'),
    imageLarge: i.thumbnailImages?.[0]?.imageUrl || small,
    url: `https://www.ebay.com/itm/${id}`,
  };
}

const token = await getToken();
const { list: raw, total } = await pullAll(token);
const cards = raw.map(toCard).filter(Boolean);
console.log(`eBay reports ${total} listings in the card category; pulled ${raw.length}; kept ${cards.length}; skipped ${raw.length - cards.length}`);
if (total > 10000) console.log('WARNING: more than 10,000 listings. eBay search stops at 10,000, so some will not show.');
if (raw.length < total) console.log(`NOTE: pulled ${total - raw.length} fewer listings than eBay reported (listings changing mid-run, or the 10,000 cap).`);
for (const i of raw) if (!toCard(i)) console.log('SKIPPED:', i.itemId, i.title);
// Safety stop: never publish an empty or broken catalog over the live site.
if (raw.length < 50 || cards.length < 50) throw new Error(`Only ${raw.length} listings came back (${cards.length} kept); not publishing`);

const counts = {};
for (const c of cards) counts[c.zone] = (counts[c.zone] || 0) + 1;
console.log('Zones:', counts);

const json = JSON.stringify(cards);
const template = await readFile(new URL('./index.template.html', import.meta.url), 'utf8');
const MARK = '/*CATALOG*/[]/*END*/';
if (!template.includes(MARK)) throw new Error('Catalog marker missing from index.template.html');
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', template.replace(MARK, json.replace(/<\//g, '<\\/')));
await writeFile('dist/catalog.json', json);
