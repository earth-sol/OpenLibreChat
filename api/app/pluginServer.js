const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');

// Serve plugin assets
if (fs.existsSync(PLUGINS_DIR)) {
  router.use('/plugins', express.static(PLUGINS_DIR, {
    index: false,
    extensions: ['js', 'json']
  }));
}

// List manifests
router.get('/api/plugins', (req, res) => {
  const list = [];
  if (fs.existsSync(PLUGINS_DIR)) {
    for (const id of fs.readdirSync(PLUGINS_DIR)) {
      const mfile = path.join(PLUGINS_DIR, id, 'manifest.json');
      if (fs.existsSync(mfile)) {
        const m = JSON.parse(fs.readFileSync(mfile, 'utf8'));
        m.url = `/plugins/${id}`;
        list.push(m);
      }
    }
  }
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json(list);
});

module.exports = router;
