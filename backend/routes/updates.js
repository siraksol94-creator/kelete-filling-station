const router = require('express').Router();
const https = require('https');

const GH_TOKEN = process.env.GH_TOKEN;
const GH_OWNER = process.env.GH_OWNER || 'siraksol94-creator';
const GH_REPO  = process.env.GH_REPO  || 'kelete-pos-tenant';

// Fetch JSON from GitHub API with auth
function ghAPI(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        'User-Agent': 'kelete-pos-updater',
        Accept: 'application/vnd.github.v3+json',
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Stream a GitHub release asset to the response (follows redirect)
function streamAsset(assetUrl, res) {
  const options = {
    hostname: 'api.github.com',
    path: assetUrl.replace('https://api.github.com', ''),
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      'User-Agent': 'kelete-pos-updater',
      Accept: 'application/octet-stream',
    },
  };
  https.get(options, (ghRes) => {
    // GitHub returns a 302 redirect to S3 â€” send it directly to the client
    if (ghRes.statusCode === 302 || ghRes.statusCode === 301) {
      res.redirect(302, ghRes.headers.location);
    } else {
      ghRes.pipe(res);
    }
  }).on('error', () => res.status(502).end());
}

// GET /api/updates/latest.yml  â€” electron-updater polls this
router.get('/latest.yml', async (req, res) => {
  try {
    if (!GH_TOKEN) return res.status(503).send('Update server not configured');
    const release = await ghAPI(`/repos/${GH_OWNER}/${GH_REPO}/releases/latest`);
    const asset = release.assets && release.assets.find(a => a.name === 'latest.yml');
    if (!asset) return res.status(404).send('latest.yml not found in latest release');
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    streamAsset(asset.url, res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// GET /api/updates/:filename  â€” electron-updater downloads installer via this
router.get('/:filename', async (req, res) => {
  try {
    if (!GH_TOKEN) return res.status(503).send('Update server not configured');
    const filename = req.params.filename;
    const release = await ghAPI(`/repos/${GH_OWNER}/${GH_REPO}/releases/latest`);
    const asset = release.assets && release.assets.find(a => a.name === filename);
    if (!asset) return res.status(404).send(`Asset "${filename}" not found`);
    streamAsset(asset.url, res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

module.exports = router;
