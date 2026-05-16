const express = require('express');
const router = express.Router();
const { getAllApps } = require('../lib/registry');

router.get('/', (req, res) => {
  const apps = getAllApps();
  const deployedCount = Object.keys(apps).length;

  res.json({
    status: 'healthy',
    service: 'Sycord Deployment Server',
    instance: 'M1',
    server_host: process.env.SERVER_HOST || 'micro1.sycord.com',
    deployed_sites: deployedCount
  });
});

module.exports = router;
