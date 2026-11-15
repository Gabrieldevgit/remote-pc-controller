// GET /api/latest — the newest GitHub release of Remote PC, for the
// website's download buttons.
//
// Vercel caches the answer at the edge (10 min, then served stale while it
// refreshes), so visitors never hit GitHub's 60-requests-per-hour limit for
// unauthenticated calls. Publishing a new GitHub release is all it takes to
// update the site. An optional GITHUB_TOKEN env var raises the limit further.

const REPO = 'Gabrieldevgit/remote-pc-controller';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** Pick the download for each platform by file name. */
function pickAssets(assets) {
  const find = (re) => {
    const a = assets.find((x) => re.test(x.name));
    return a ? { name: a.name, url: a.browser_download_url, size: a.size } : null;
  };
  return {
    windowsSetup: find(/setup.*\.exe$/i),
    windowsPortable: find(/portable.*\.exe$/i),
    android: find(/\.apk$/i),
  };
}

module.exports = async function handler(req, res) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'remote-pc-website',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let body;
  let cache = 's-maxage=600, stale-while-revalidate=86400';
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (r.status === 404) {
      // No published release yet.
      body = { available: false, page: RELEASES_PAGE };
    } else if (!r.ok) {
      body = { available: false, page: RELEASES_PAGE, error: `github_${r.status}` };
      cache = 's-maxage=60, stale-while-revalidate=600';
    } else {
      const rel = await r.json();
      body = {
        available: true,
        version: String(rel.tag_name || '').replace(/^v/i, ''),
        name: rel.name || rel.tag_name,
        publishedAt: rel.published_at,
        page: rel.html_url || RELEASES_PAGE,
        assets: pickAssets(Array.isArray(rel.assets) ? rel.assets : []),
      };
    }
  } catch {
    body = { available: false, page: RELEASES_PAGE, error: 'unreachable' };
    cache = 's-maxage=60, stale-while-revalidate=600';
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=0, ${cache}`);
  res.statusCode = 200;
  res.end(JSON.stringify(body));
};

module.exports.pickAssets = pickAssets;
