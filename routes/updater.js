const express = require('express');
const router = express.Router();
const updater = require('../lib/autoUpdater');

router.get('/status', (req, res) => {
  res.json({ success: true, ...updater.getState() });
});

router.post('/check', async (req, res) => {
  const s = await updater.check();
  res.json({ success: true, ...s });
});

router.post('/update', async (req, res) => {
  const result = await updater.update({ restart: true });
  res.json(result);
});

module.exports = router;
