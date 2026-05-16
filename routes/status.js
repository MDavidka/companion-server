const express = require('express');
const router = express.Router();
const { getAllApps } = require('../lib/registry');

router.get('/', (req, res) => {
  const apps = getAllApps();
  const sites = Object.keys(apps).map(name => ({
    name,
    ...apps[name]
  }));

  res.json({
    success: true,
    status: 'healthy',
    sites: sites,
    total: sites.length
  });
});

module.exports = router;
