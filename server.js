/* Redraw server: serves the game files and relays room messages over WebSocket. No database; rooms live in memory. */
const http = require('http'), fs = require('fs'), path = require('path'), { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, GRACE = +process.env.GRACE_MS || 10000, MAXP = 16;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const FILES = new Set(['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname, f = p === '/' ? 'index.html' : p.slice(1);
  if (f === 'health') { res.writeHead(200); return res.end('ok'); }
  if (!FILES.has(f)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, f), (e, b) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f === 'index.html' || f === 'sw.js' ? 'no-cache' : 'public, max-age=3600' });
    res.end(b);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const rooms = new Map(); // room -> Map(pid -> {ws, pres, timer})
const send = (m, o) => { if (m.ws && m.ws.readyState === 1) { try { m.ws.send(JSON.stringify(o)); } catch (e) {} } };

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, room = q.get('room') || '', pid = q.get('pid') || '';
  if (!/^[\w-]{3,40}$/.test(room) || !/^[\w-]{4,40}$/.test(pid)) return ws.close(4000);
  let R = rooms.get(room); if (!R) { R = new Map(); rooms.set(room, R); }
  let me = R.get(pid);
  if (me) { // same player reconnecting: keep their slot, no one sees them leave
    clearTimeout(me.timer); me.timer = null;
    if (me.ws && me.ws.readyState === 1) { send(me, { a: 'replaced' }); me.ws.close(4001); }
    me.ws = ws;
  } else {
    if (R.size >= MAXP) return ws.close(4002);
    me = { ws, pres: null, timer: null }; R.set(pid, me);
  }
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  send(me, { a: 'peers', list: [...R].filter(([k, v]) => k !== pid && v.pres).map(([k, v]) => ({ pid: k, p: v.pres })) });

  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || R.get(pid) !== me || me.ws !== ws) return;
    if (m.a === 'pres') {
      me.pres = m.p && typeof m.p === 'object' ? m.p : null;
      R.forEach((v, k) => { if (k !== pid) send(v, { a: 'pres', from: pid, p: me.pres }); });
    } else if (m.a === 'x' && typeof m.t === 'string') {
      const o = { a: 'x', t: m.t, d: m.d, from: pid };
      if (m.to) { const v = R.get(m.to); if (v) send(v, o); }
      else R.forEach((v, k) => { if (k !== pid) send(v, o); });
    }
  });
  ws.on('close', () => {
    if (me.ws !== ws) return;
    me.timer = setTimeout(() => { // only announce "left" if they don't come back within the grace period
      if (R.get(pid) === me && me.ws === ws) {
        R.delete(pid); R.forEach(v => send(v, { a: 'left', from: pid }));
        if (!R.size) rooms.delete(room);
      }
    }, GRACE);
  });
  ws.on('error', () => {});
});

setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 15000);
setInterval(() => wss.clients.forEach(ws => { try { if (ws.readyState === 1) ws.send('{"a":"ping"}'); } catch (e) {} }), 4000);

server.listen(PORT, () => console.log('Redraw running on port ' + PORT));
