const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const router = express.Router();

const ROOT = path.join(__dirname, '..');

function respawnSelf() {
  console.log('[system] respawning runner process...');
  const child = spawn(process.argv[0], process.argv.slice(1), {
    cwd: ROOT,
    detached: true,
    stdio: 'inherit',
    env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
}

// POST /api/system/reset — restart runner on Ubuntu (systemd) or respawn process
router.post('/reset', (req, res) => {
  const svc = process.env.SYSTEMD_SERVICE || 'companion-server';
  console.log(`[system] reset requested (service=${svc})`);

  // Reply first, then trigger restart
  res.json({
    success: true,
    message: `Reset triggered. Attempting systemctl restart ${svc}, falling back to in-process respawn.`,
    service: svc,
    pid: process.pid,
    platform: process.platform
  });

  setTimeout(() => {
    exec(`sudo -n systemctl restart ${svc}`, (err, stdout, stderr) => {
      if (!err) {
        console.log(`[system] systemctl restart ${svc} OK`);
        return;
      }
      console.warn(`[system] systemctl restart failed (${err.message}); falling back to respawn`);
      try {
        respawnSelf();
      } catch (e) {
        console.error('[system] respawn failed:', e.message);
        process.exit(1);
      }
    });
  }, 300);
});

module.exports = router;
