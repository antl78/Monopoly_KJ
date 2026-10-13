// Tests du serveur multijoueur : vraies connexions WebSocket, temps simulé.
// Nécessite les dépendances du serveur :  npm install --prefix monopoly-server
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.QUIET = '1';
process.env.SNAPSHOT_SECRET = 'secret-de-test-assez-long';
const { server, rooms, stop } = require('../monopoly-server/server.js');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = 'localhost:' + server.address().port; r(); })));
test.after(() => stop());

// Petit client de test : garde tous les messages reçus, permet d'en attendre un.
function client() {
  const ws = new WebSocket('ws://' + base);
  const c = { ws, msgs: [], waiters: [] };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => { if (w.pred(m)) { w.res(m); return false; } return true; });
  };
  c.send = m => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 3000) => {
    if (typeof pred === 'string') { const t = pred; pred = m => m.type === t; }
    const found = c.msgs.find(pred);
    if (found) { c.msgs.splice(c.msgs.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((res, rej) => {
      const w = { pred, res: m => { c.msgs.splice(c.msgs.indexOf(m), 1); clearTimeout(w.t); res(m); } };
      w.t = setTimeout(() => rej(new Error('attente dépassée : ' + pred)), ms);
      c.waiters.push(w);
    });
  };
  c.clear = () => { c.msgs = []; };
  c.open = new Promise(r => { ws.onopen = r; });
  c.close = () => new Promise(r => { ws.onclose = r; ws.close(); });
  return c;
}

async function lobbyWithTwo() {
  const a = client(), b = client();
  await a.open; await b.open;
  a.send({ type: 'create_room', name: 'Antoine', pawn: '🎩' });
  const ja = await a.wait('joined');
  b.send({ type: 'join_room', code: ja.code.toLowerCase(), name: 'Bob', pawn: '🚂' });
  const jb = await b.wait('joined');
  await a.wait(m => m.type === 'lobby' && m.seats.length === 2);
  return { a, b, ja, jb, code: ja.code, room: () => rooms.get(ja.code) };
}
async function started() {
  const x = await lobbyWithTwo();
  x.a.send({ type: 'start' });
  x.ga = await x.a.wait('game'); x.gb = await x.b.wait('game');
  return x;
}

test('sert le jeu, pas les éditeurs ni le code du serveur', async () => {
  const get = p => fetch('http://' + base + p);
  assert.equal((await get('/')).status, 200);
  assert.match(await (await get('/engine.js')).text(), /MonoEngine/);
  assert.equal((await get('/images/alerte.png')).headers.get('content-type'), 'image/png');
  assert.equal((await get('/monopoly-editor.html')).status, 404);
  assert.equal((await get('/monopoly-server/server.js')).status, 404);
  assert.equal((await get('/images/..%2fserver.js')).status, 404);
  assert.equal((await get('/health')).status, 200);
});

test('lobby : réglages réservés à l\'hôte, lancement, plateau officiel par défaut', async () => {
  const { a, b, room } = await lobbyWithTwo();
  b.send({ type: 'lobby_config', config: { startMoney: 9999 } });
  await b.wait('error');
  a.send({ type: 'lobby_config', config: { startMoney: 2000, auctions: false, timerSec: 60 } });
  const l = await b.wait(m => m.type === 'lobby' && m.config.startMoney === 2000);
  assert.equal(l.timerSec, 60);
  b.send({ type: 'start' }); await b.wait('error');
  a.send({ type: 'start' });
  const g = await b.wait('game');
  assert.equal(g.board[0].name, 'Entrée sanctuaire');
  assert.equal(g.state.players[1].money, 2000);
  assert.equal(g.state.secret, undefined);
  assert.equal(g.state.board, undefined);                  // plateau envoyé à part
  assert.equal(room().state.config.auctions, false);
  a.ws.close(); b.ws.close();
});

test('lobby : un même pion emoji ne peut pas être pris deux fois', async () => {
  const a = client(), b = client(); await a.open; await b.open;
  a.send({ type: 'create_room', name: 'A', pawn: '🐉' });
  const ja = await a.wait('joined');
  b.send({ type: 'join_room', code: ja.code, name: 'B', pawn: '🐉' });
  const l = await b.wait(m => m.type === 'lobby' && m.seats.length === 2);
  assert.notEqual(l.seats[1].pawn, '🐉');
  b.send({ type: 'lobby_me', pawn: '🐉' });
  assert.match((await b.wait('error')).message, /déjà pris/);
  a.ws.close(); b.ws.close();
});

test('pions en image : envoyés une seule fois, jamais dans les mises à jour', async () => {
  const a = client(), b = client(); await a.open; await b.open;
  const img = 'data:image/png;base64,' + 'A'.repeat(4000);
  a.send({ type: 'create_room', name: 'A', pawn: img });
  const ja = await a.wait('joined');
  b.send({ type: 'join_room', code: ja.code, name: 'B', pawn: '🚂' });
  await a.wait(m => m.type === 'lobby' && m.seats.length === 2);
  a.send({ type: 'start' });
  const g = await b.wait('game');
  assert.equal(g.pawns[0], img);
  assert.equal(g.state.players[0].pawn, 'img:0');
  a.send({ type: 'act', action: { type: 'roll' } });
  const u = await b.wait('update');
  assert.ok(!JSON.stringify(u).includes('data:image'));
  a.ws.close(); b.ws.close();
});

test('actions : chacun son tour, mises à jour diffusées à tous', async () => {
  const { a, b } = await started();
  b.send({ type: 'act', action: { type: 'roll' } });
  const e = await b.wait('error');
  assert.match(e.message, /pas votre tour/);
  a.send({ type: 'act', action: { type: 'roll' } });
  const ua = await a.wait('update'), ub = await b.wait('update');
  assert.equal(ua.v, ub.v);
  assert.ok(ub.events.some(ev => ev.t === 'dice'));
  assert.equal(ub.state.secret, undefined);
  assert.equal(ub.state.board, undefined);
  a.ws.close(); b.ws.close();
});

test('reconnexion avec la clé secrète, place gardée ; mauvaise clé refusée', async () => {
  const { a, b, code, jb } = await started();
  await b.close();
  const meta = await a.wait(m => m.type === 'meta' && !m.meta.seats[1].connected);
  assert.ok(meta.meta.seats[1].graceLeft > 0);
  const b2 = client(); await b2.open;
  b2.send({ type: 'resume', code, token: 'fausse-cle' });
  assert.equal((await b2.wait('resume_failed')).reason, 'unknown_seat');
  b2.send({ type: 'resume', code, token: jb.token });
  assert.equal((await b2.wait('joined')).seat, 1);
  await b2.wait('game');
  a.ws.close(); b2.ws.close();
});

test('sauvegarde : restauration après perte du salon, falsification refusée', async () => {
  const { a, b, code, ja, jb, ga } = await started();
  a.send({ type: 'act', action: { type: 'roll' } });
  await a.wait('update');
  const s = await a.wait('snapshot');                       // envoyée au lancement
  assert.ok(!s.blob.includes('Antoine'));                   // chiffrée : illisible
  a.ws.close(); b.ws.close();
  rooms.delete(code);                                       // « Render a redémarré »

  const c = client(); await c.open;
  c.send({ type: 'resume', code, token: ja.token });
  await c.wait('resume_failed');
  const tampered = s.blob.slice(0, -4) + (s.blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  c.send({ type: 'restore', snapshot: tampered, board: ga.board, cards: ga.cards, pawns: ga.pawns });
  assert.equal((await c.wait('error')).code, 'bad_snapshot');
  const board2 = JSON.parse(JSON.stringify(ga.board)); board2[39].rents[0] = 1;
  c.send({ type: 'restore', snapshot: s.blob, board: board2, cards: ga.cards, pawns: ga.pawns });
  assert.equal((await c.wait('error')).code, 'bad_snapshot');
  c.send({ type: 'restore', snapshot: s.blob, board: ga.board, cards: ga.cards, pawns: ga.pawns });
  await c.wait('restored');
  c.send({ type: 'resume', code, token: ja.token });
  assert.equal((await c.wait('joined')).seat, 0);
  const g = await c.wait('game');
  assert.equal(g.state.players[0].name, 'Antoine');
  const d = client(); await d.open;
  d.send({ type: 'resume', code, token: jb.token });
  assert.equal((await d.wait('joined')).seat, 1);
  c.ws.close(); d.ws.close();
});

test('pause de l\'hôte : plus aucune action jusqu\'à la reprise', async () => {
  const { a, b } = await started();
  b.send({ type: 'host', cmd: 'pause' }); await b.wait('error');
  a.send({ type: 'host', cmd: 'pause' });
  await b.wait(m => m.type === 'meta' && m.meta.paused);
  a.send({ type: 'act', action: { type: 'roll' } });
  assert.match((await a.wait('error')).message, /pause/);
  a.send({ type: 'host', cmd: 'resume' });
  await b.wait(m => m.type === 'meta' && !m.meta.paused);
  a.send({ type: 'act', action: { type: 'roll' } });
  await b.wait('update');
  a.ws.close(); b.ws.close();
});

test('« Je m\'absente » : ses tours sont joués prudemment', async () => {
  const { a, b, room } = await started();
  a.send({ type: 'presence', away: true });
  await b.wait(m => m.type === 'meta' && m.meta.seats[0].away);
  const r = room();
  for (let i = 0; i < 20 && r.state.current === 0; i++) r.tick(Date.now() + 5000 * (i + 1));
  assert.equal(r.state.current, 1);                          // son tour a été joué et fini
  assert.equal(r.state.players[0].properties.length, 0);     // le mode auto n'achète jamais
  a.ws.close(); b.ws.close();
});

test('minuteur : action par défaut à l\'expiration, puis mode absent', async () => {
  const { a, b, room } = await started();
  a.send({ type: 'host', cmd: 'timer', value: 30 });
  await a.wait('meta');
  const r = room();
  const seq = r.state.seq;
  r.tick(Date.now() + 31000);
  assert.equal(r.state.seq, seq + 1);                        // lancer joué pour lui
  r.tick(Date.now() + 62000);
  assert.ok(r.seats[0].away);                                // 2e expiration → absent
  a.ws.close(); b.ws.close();
});

test('déconnexion prolongée : l\'hôte décide (auto / retirer)', async () => {
  const { a, b, room } = await started();
  const r = room();
  const E = require('../engine.js');
  for (let i = 0; i < 50 && r.state.current === 0; i++) {       // on joue le tour d'Antoine
    const who = E.awaiting(r.state)[0];
    assert.equal(r.act(who, E.autoAction(r.state, who)), null);
  }
  assert.equal(r.state.current, 1);
  await b.close();
  await a.wait(m => m.type === 'meta' && !m.meta.seats[1].connected);
  r.timerSec = 0; r.deadline = null;
  r.tick(Date.now() + 121000);
  assert.ok(r.seats[1].needsDecision);
  a.send({ type: 'host', cmd: 'remove', seat: 1 });
  await a.wait(m => m.type === 'update' && m.state.phase === 'ended');
  a.ws.close();
});

test('messages hostiles ignorés proprement', async () => {
  const { a, b } = await started();
  a.ws.send('pas du json');
  await a.wait('error');
  a.send({ type: 'act', action: { type: '__proto__' } });
  await a.wait('error');
  a.send({ type: 'act', action: { type: 'end_by_worth' } });   // réservé au serveur
  await a.wait('error');
  a.send({ type: 'chat', text: '<img src=x onerror=alert(1)>' + 'x'.repeat(1000) });
  const c = await b.wait('chat');
  assert.ok(c.msg.text.length <= 300);
  a.ws.close(); b.ws.close();
});
