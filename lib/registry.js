const fs = require('fs');
const path = require('path');

const REGISTRY_FILE = path.join(__dirname, '..', 'registry.json');
let registry = {};

function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    try {
      const data = fs.readFileSync(REGISTRY_FILE, 'utf8');
      registry = JSON.parse(data);
    } catch (e) {
      console.error('Error loading registry:', e);
      registry = {};
    }
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving registry:', e);
  }
}

function getApp(name) {
  return registry[name];
}

function getAllApps() {
  return { ...registry };
}

function registerApp(name, appData) {
  registry[name] = { ...registry[name], ...appData, updatedAt: new Date().toISOString() };
  saveRegistry();
}

function removeApp(name) {
  delete registry[name];
  saveRegistry();
}

// Initialize
loadRegistry();

module.exports = {
  getApp,
  getAllApps,
  registerApp,
  removeApp
};
