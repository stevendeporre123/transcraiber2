'use strict';
// Kleine mock van de Director API + Keycloak-tokenendpoint, voor tests en UI-demo.
const http = require('node:http');

function createMockServer() {
  const calls = [];
  const members = {
    'M1': [
      { id: '19.0101.0000.0001', firstName: 'An', lastName: 'Peeters', role: 'Voorzitter', status: 'PRESENT' },
      { id: '19.0101.0000.0002', firstName: 'Bram', lastName: 'De Smet', role: 'Raadslid', status: 'ABSENT' },
      { id: '19.0101.0000.0003', firstName: 'Chloë', lastName: 'Janssens', role: 'Raadslid', status: null },
    ],
  };
  let tokenCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (url.pathname === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== 'geheim') return send(401, { error: 'unauthorized_client', error_description: 'Invalid client secret' });
        return send(200, { access_token: 'tok' + (++tokenCount), expires_in: 300 });
      }
      if (req.headers.authorization !== 'Bearer tok' + tokenCount) return send(401, { message: 'bad token' });
      if (url.pathname === '/api/v1/director/organs') return send(200, [{ id: '12.0623.8213.4871', name: 'Gemeenteraad' }, { id: '15.0623.8213.2303', name: 'Commissie Financiën' }]);
      if (url.pathname === '/api/v1/director/meetings') {
        if (!url.searchParams.get('organ') && !url.searchParams.get('status')) return send(400, { message: 'organ or status required' });
        return send(200, { content: [
          { id: 'M1', meetingDate: '2026-11-17T19:00:00', organ: { id: '12.0623.8213.4871', name: 'Gemeenteraad' }, title: 'Gemeenteraad november', status: 'AGENDA_PUBLISHED_INTERNAL' },
          { id: 'M2', meetingDate: '2026-11-10T19:30:00', organ: { id: '15.0623.8213.2303' }, status: 'AGENDA_CLOSED' },
        ] });
      }
      let m = url.pathname.match(/^\/api\/v1\/director\/meetings\/([^/]+)\/members$/);
      if (m && req.method === 'GET') return send(200, members[decodeURIComponent(m[1])] || []);
      m = url.pathname.match(/^\/api\/v1\/director\/meetings\/([^/]+)\/members\/([^/]+)$/);
      if (m && req.method === 'PATCH') {
        const list = members[decodeURIComponent(m[1])] || [];
        const mem = list.find(x => x.id === decodeURIComponent(m[2]));
        if (!mem) return send(403, { message: 'Access denied' });
        const patch = JSON.parse(body || '{}');
        if (!patch.status) return send(400, { message: 'status required' });
        mem.status = patch.status;
        res.writeHead(200); return res.end();
      }
      send(404, { message: 'not found' });
    });
  });
  return {
    server, calls, members,
    expireToken: () => { tokenCount++; },
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { createMockServer };

if (require.main === module) {
  const mock = createMockServer();
  mock.server.listen(Number(process.env.PORT) || 4010, () => console.log('Mock op http://127.0.0.1:' + mock.server.address().port + '  (token-URL /token, secret "geheim")'));
}
