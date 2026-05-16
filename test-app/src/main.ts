interface DeployInfo {
  host: string;
  loadedAt: string;
  buildTool: string;
  language: string;
}

function getDeployInfo(): DeployInfo {
  return {
    host: window.location.hostname,
    loadedAt: new Date().toUTCString(),
    buildTool: 'Vite',
    language: 'TypeScript',
  };
}

function render(info: DeployInfo): string {
  return `
    <div class="card">
      <div class="badge">✓ Deployed</div>
      <h1>Sycord Test App</h1>
      <p class="subtitle">This page was built with ${info.buildTool} + ${info.language} and served by the Sycord wildcard subdomain deployment pipeline.</p>
      <table>
        <tr><th>Host</th><td>${info.host}</td></tr>
        <tr><th>Page loaded</th><td>${info.loadedAt}</td></tr>
        <tr><th>Build tool</th><td>${info.buildTool}</td></tr>
        <tr><th>Language</th><td>${info.language}</td></tr>
      </table>
      <p class="note">If you can read this page on a subdomain of <code>micro1.sycord.com</code>, the nginx wildcard routing and deployment pipeline are working correctly.</p>
    </div>
  `;
}

const root = document.getElementById('app');
if (root) {
  root.innerHTML = render(getDeployInfo());
}
