const net = require('net');

async function findFreePort(startPort = 3001, endPort = 4000) {
  for (let port = startPort; port <= endPort; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free ports available between ${startPort} and ${endPort}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, '127.0.0.1');
  });
}

module.exports = {
  findFreePort,
  isPortFree
};
