const express = require('express');
const router = express.Router();
const { getLogs } = require('../lib/pipeline');

router.get('/:name', (req, res) => {
  const appName = req.params.name;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const existingLogs = getLogs(appName);
  if (existingLogs && existingLogs.length > 0) {
    existingLogs.forEach(log => {
      res.write(`data: ${JSON.stringify({ log })}\n\n`);
    });
  }

  // To truly support SSE, we would need to hook into the child process stdout dynamically
  // or poll the logs buffer. For simplicity, we can poll the buffer and send new lines.
  let lastLogIndex = existingLogs ? existingLogs.length : 0;
  
  const interval = setInterval(() => {
    const logs = getLogs(appName);
    if (logs && logs.length > lastLogIndex) {
      for (let i = lastLogIndex; i < logs.length; i++) {
        res.write(`data: ${JSON.stringify({ log: logs[i] })}\n\n`);
      }
      lastLogIndex = logs.length;
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

module.exports = router;
