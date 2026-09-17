/**
 * Standalone GitHub Actions poller — same job as functions/pollFacebookPage,
 * as a free alternative to the paid Firebase Blaze plan that Cloud Functions
 * requires. Reads the Page's feed + comments for fire keywords, writes
 * located mentions into `reports/` so they enter the normal triage pipeline,
 * and drops unlocatable ones into `facebookLeads/` for a person to place.
 *
 * Runs with plain `node` (see poll-facebook.yml), not through Vite, so it
 * can't use `import.meta.env` (that's Vite's doing, not Node's — it stays
 * undefined outside a Vite build and made the previous version of this file
 * throw immediately). Talks to Realtime Database over its REST API with
 * global fetch instead of the `firebase` client SDK, so there's no browser-
 * only API to polyfill and no extra dependency to install in CI.
 *
 * Requires FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FIREBASE_DATABASE_URL in the
 * environment (see poll-facebook.yml) and a database whose rules allow this
 * script to read/write `reports`, `facebookLeads`, and `_meta` without auth —
 * the same access the client app already relies on from the browser.
 */

const { FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FIREBASE_DATABASE_URL } = process.env;

for (const [name, value] of Object.entries({ FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FIREBASE_DATABASE_URL })) {
  if (!value) {
    console.error(`[poll-facebook] Missing required env var ${name}`);
    process.exit(1);
  }
}

// English, Filipino, and Bisaya/Surigaonon — match whichever a resident
// actually types. Keep this in sync with functions/index.js's copy.
const FIRE_KEYWORDS = [
  'fire', 'burning', 'flames', 'ablaze', 'smoke',
  'sunog', 'nasunog', 'nagsunog', 'sinunog',
  'kalayo', 'nagkalayo', 'gikalayo', 'gisunog',
];

function mentionsFire(text = '') {
  const lower = text.toLowerCase();
  return FIRE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Kept in sync with src/data/surigao.js by hand — this script is CommonJS-
 * adjacent Node, not part of the Vite build, so it can't just import that
 * file's ESM export the way functions/index.js's comment wishes it could.
 */
const BARANGAYS = [
  { id: 'washington', name: 'Washington', center: [9.7880, 125.4936] },
  { id: 'taft', name: 'Taft', center: [9.7852, 125.4907] },
  { id: 'luna', name: 'Luna', center: [9.7902, 125.4881] },
  { id: 'rizal', name: 'Rizal', center: [9.7826, 125.4948] },
  { id: 'san_juan', name: 'San Juan', center: [9.7774, 125.4890] },
  { id: 'canlanipa', name: 'Canlanipa', center: [9.7709, 125.4934] },
  { id: 'punta_bilar', name: 'Punta Bilar', center: [9.7963, 125.4975] },
  { id: 'ipil', name: 'Ipil', center: [9.7649, 125.4861] },
  { id: 'cagniog', name: 'Cagniog', center: [9.8025, 125.4812] },
  { id: 'quezon', name: 'Quezon', center: [9.7795, 125.4835] },
];

function matchBarangay(text = '') {
  const lower = text.toLowerCase();
  return BARANGAYS.find((b) => lower.includes(b.name.toLowerCase())) ?? null;
}

const dbUrl = FIREBASE_DATABASE_URL.replace(/\/$/, '');

async function dbGet(path) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function dbSet(path, value) {
  const res = await fetch(`${dbUrl}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
}

async function main() {
  const since = (await dbGet('_meta/lastFacebookPoll')) || Math.floor(Date.now() / 1000) - 300;

  const url = new URL(`https://graph.facebook.com/v21.0/${FB_PAGE_ID}/feed`);
  url.searchParams.set('fields', 'message,created_time,permalink_url,comments{message,created_time}');
  url.searchParams.set('since', String(since));
  url.searchParams.set('access_token', FB_PAGE_ACCESS_TOKEN);

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    console.error('[poll-facebook] Graph API error', body?.error ?? body);
    process.exit(1);
  }

  let newest = since;
  let located = 0;
  let leads = 0;

  for (const post of body.data ?? []) {
    const postTime = Math.floor(new Date(post.created_time).getTime() / 1000);
    newest = Math.max(newest, postTime);

    const candidates = [
      { text: post.message, id: post.id },
      ...((post.comments?.data) ?? []).map((c) => ({ text: c.message, id: c.id })),
    ];

    for (const c of candidates) {
      if (!c.text || !mentionsFire(c.text)) continue;

      const barangay = matchBarangay(c.text);
      const reportedAt = new Date(postTime * 1000).toISOString();
      const note = c.text.slice(0, 280);

      if (barangay) {
        // Located — enters the normal pipeline. On its own this scores
        // below the auto-post threshold (text only, no image), so it shows
        // as a Light Warning until something corroborates it: a second
        // Facebook mention, an app report, or the aerial sweep.
        await dbSet(`reports/fb-${c.id}`, {
          id: `fb-${c.id}`,
          location: barangay.center,
          barangayId: barangay.id,
          source: 'facebook',
          modelConfidence: 0.55,
          note,
          driveUrl: null,
          reportedAt,
        });
        located += 1;
      } else {
        // No barangay named in the text — can't be plotted, so it waits
        // here for a person to add a location rather than guessing one.
        await dbSet(`facebookLeads/fb-${c.id}`, { id: `fb-${c.id}`, note, reportedAt });
        leads += 1;
      }
    }
  }

  await dbSet('_meta/lastFacebookPoll', newest + 1);
  console.info(`[poll-facebook] done — ${located} located report(s), ${leads} unplottable lead(s)`);
}

main().catch((err) => {
  console.error('[poll-facebook] failed', err);
  process.exit(1);
});
