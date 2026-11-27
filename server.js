const http = require('http');
const httpProxy = require('http-proxy');

const TARGET = process.env.TARGET || 'https://chromiumclient.com';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const PORT = process.env.PORT || 3000;

const targetHost = new URL(TARGET).host.replace(/\./g, '\\.');
// Matches https://host, http://host and the JSON-escaped form https:\/\/host
const hostRe = new RegExp('https?:(\\\\?/){2}' + targetHost, 'g');

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  ws: true,
  secure: true,
  selfHandleResponse: true
});

const publicOrigin = req =>
  (req.headers['x-forwarded-proto'] || 'https').split(',')[0] + '://' + req.headers.host;

proxy.on('proxyReq', (pReq, req) => {
  pReq.setHeader('accept-encoding', 'identity'); // so text can be rewritten
  if (req.headers.origin) pReq.setHeader('origin', TARGET);
  if (req.headers.referer) pReq.setHeader('referer', TARGET + '/');
});

proxy.on('proxyReqWs', pReq => pReq.setHeader('origin', TARGET));

proxy.on('proxyRes', (pRes, req, res) => {
  const pub = publicOrigin(req);
  const h = { ...pRes.headers };

  delete h['x-frame-options'];
  delete h['content-security-policy'];
  delete h['content-security-policy-report-only'];

  if (h.location) h.location = h.location.replace(hostRe, () => pub);
  if (h['set-cookie']) {
    h['set-cookie'] = h['set-cookie'].map(c => c.replace(/;\s*domain=[^;]+/i, ''));
  }

  h['access-control-allow-origin'] = ALLOW_ORIGIN;
  h['access-control-expose-headers'] = '*';

  const type = h['content-type'] || '';
  if (/text\/html|javascript|json|text\/css|xml/i.test(type)) {
    const chunks = [];
    pRes.on('data', c => chunks.push(c));
    pRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').replace(hostRe, () => pub);
      h['content-length'] = Buffer.byteLength(body);
      res.writeHead(pRes.statusCode, h);
      res.end(body);
    });
  } else {
    res.writeHead(pRes.statusCode, h);
    pRes.pipe(res);
  }
});

proxy.on('error', (err, req, res) => {
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  } else if (res && res.destroy) {
    res.destroy();
  }
});

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ALLOW_ORIGIN,
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-max-age': '86400'
    });
    return res.end();
  }
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));

server.listen(PORT, () => console.log('Proxying ' + TARGET + ' on port ' + PORT));
