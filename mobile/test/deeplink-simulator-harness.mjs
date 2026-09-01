import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? '5462')

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nessie deep-link harness</title>
    <style>
      body { align-items: center; background: #f9f6f0; color: #27231f; display: flex; font: 18px -apple-system, sans-serif; justify-content: center; margin: 0; min-height: 100vh; padding: 24px; }
      main { max-width: 340px; text-align: center; }
      code { display: block; font-size: 13px; margin-top: 16px; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <strong id="state">Waiting for notification route</strong>
      <code id="path"></code>
    </main>
    <script>
      const defaultPath = '/channels/personal-assistant';
      const state = document.getElementById('state');
      const pathElement = document.getElementById('path');
      const report = (path) => {
        history.replaceState(null, '', path);
        state.textContent = 'Exact notification destination';
        pathElement.textContent = path;
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'nessie:route', path }));
      };
      window.__nessieNavigate = report;
      window.addEventListener('nessie:native-push-path', () => {
        if (typeof window.__nessiePendingPushPath === 'string') report(window.__nessiePendingPushPath);
      });
      report(typeof window.__nessiePendingPushPath === 'string' ? window.__nessiePendingPushPath : defaultPath);
    </script>
  </body>
</html>`

createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '0.0.0.0', () => {
  console.info(`Nessie deep-link simulator harness listening on http://0.0.0.0:${port}`)
})
