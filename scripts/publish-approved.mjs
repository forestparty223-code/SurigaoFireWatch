/**
 * Publishes approved incidents to the Facebook Page.
 *
 * This is the piece reportsStore.js's comments have been describing all
 * along and that didn't exist yet: everything else in the app only ever
 * writes a record to `postApprovals/{incidentId}` — nothing in the client
 * app calls the Graph API directly. This script is what actually turns an
 * approval into a public post.
 *
 * Rule it follows, no exceptions: publish an incident ONLY if it has a
 * `postApprovals/{id}` record with `text` set and no `postedAt` yet. It
 * never recomputes triage, never decides anything is "confirmed enough" on
 * its own, and never touches `text` — that string was frozen at approval
 * time (auto or by an admin in IncidentPanel) and is posted verbatim, so
 * what goes out is exactly what was shown on screen when it was approved.
 *
 * Run on a schedule (see publish-approved.yml) so a 'confirmed' incident's
 * auto-approval actually reaches the Page without you opening the app.
 */

const { FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FIREBASE_DATABASE_URL } = process.env;

for (const [name, value] of Object.entries({ FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FIREBASE_DATABASE_URL })) {
  if (!value) {
    console.error(`[publish-approved] Missing required env var ${name}`);
    process.exit(1);
  }
}

const dbUrl = FIREBASE_DATABASE_URL.replace(/\/$/, '');

async function dbGet(path) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

/** Partial update — only touches the keys in `patch`, leaves the rest alone. */
async function dbPatch(path, patch) {
  const res = await fetch(`${dbUrl}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
}

/**
 * One post to the Page's feed. Graph API errors come back as HTTP 200 with
 * an `error` object in the body as often as they come back as a non-2xx
 * status, so both are checked.
 */
async function postToFacebook(message) {
  const url = new URL(`https://graph.facebook.com/v21.0/${FB_PAGE_ID}/feed`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message, access_token: FB_PAGE_ACCESS_TOKEN }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = body.error ?? { message: `HTTP ${res.status}`, type: 'http_error' };
    // Graph API's own fields — surfacing all three is the difference between
    // "expired token" (code 190), "missing pages_manage_posts permission"
    // (code 200-ish/subcode), and "page not found" (code 100) in the logs,
    // instead of one generic failure line.
    throw Object.assign(new Error(`${err.message} (type=${err.type}, code=${err.code}, subcode=${err.error_subcode})`), { graphError: err });
  }
  return body.id; // "{page-id}_{post-id}"
}

async function main() {
  const approvals = (await dbGet('postApprovals')) || {};
  const pending = Object.entries(approvals).filter(([, a]) => a.text && !a.postedAt);

  if (pending.length === 0) {
    console.info('[publish-approved] nothing to publish');
    return;
  }

  let posted = 0;
  let failed = 0;

  for (const [incidentId, approval] of pending) {
    try {
      const postId = await postToFacebook(approval.text);
      await dbPatch(`postApprovals/${incidentId}`, {
        postedAt: new Date().toISOString(),
        postId,
        lastError: null,
      });
      console.info(`[publish-approved] posted ${incidentId} -> ${postId}`);
      posted += 1;
    } catch (err) {
      // Left without `postedAt` so the next run retries it — but the error
      // is recorded so IncidentPanel could eventually surface it, and so it
      // shows up here in the Action logs without needing to reproduce it.
      console.error(`[publish-approved] failed to post ${incidentId}:`, err.message);
      await dbPatch(`postApprovals/${incidentId}`, { lastError: err.message }).catch(() => {});
      failed += 1;
    }
  }

  console.info(`[publish-approved] done — ${posted} posted, ${failed} failed`);
  if (failed > 0 && posted === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[publish-approved] fatal', err);
  process.exit(1);
});
