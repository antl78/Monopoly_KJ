// ════════════════════════════════════════════════════════════════════════════
// server.js — Serveur multijoueur de Monopoly KJ
// ────────────────────────────────────────────────────────────────────────────
// • Sert le jeu lui-même (monopoly-game.html, engine.js, images, plateau.json,
//   cartes.json) depuis la racine du repo : les joueurs n'ont qu'à ouvrir l'URL.
// • Gère les salons en WebSocket. Le protocole est décrit dans protocol.md.
// • Aucune règle de jeu ici : tout passe par le moteur partagé ../engine.js.
//
// Lancer en local :  npm install --prefix monopoly-server
//                    node monopoly-server/server.js      → http://localhost:3000
// Variables d'environnement :
//   PORT             port d'écoute (Render le fournit)
//   SNAPSHOT_SECRET  clé des sauvegardes (au moins 16 caractères) — OBLIGATOIRE
//                    en ligne, sinon les sauvegardes ne survivent pas à un redémarrage
//   GAME_ROOT        dossier du jeu (par défaut : le dossier parent de ce fichier)
// ════════════════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const E = require('../engine.js');
const snap = require('./snapshot.js');
const { Room, cleanPawn, clampName } = require('./room.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(process.env.GAME_ROOT || path.join(__dirname, '..'));
const MAX_MSG = 3 * 1024 * 1024;          // un plateau perso avec images peut peser lourd
const PROTOCOL = 1;

// ── Fichiers servis (liste blanche : les éditeurs restent hors du serveur) ──
const STATIC = {
  '/': ['monopoly-game.html', 'text/html; charset=utf-8'],
  '/monopoly-game.html': ['monopoly-game.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/plateau.json': ['plateau.json', 'application/json; charset=utf-8'],
  '/cartes.json': ['cartes.json', 'application/json; charset=utf-8'],
};
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };

const rooms = new Map();

function official() {
  const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const p = read('plateau.json');
  return { board: p.board || p, cards: E.normalizeCards(read('cartes.json')) };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (url.pathname === '/health') {
    res.writeHead(200, Object.assign(headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end(); return; }
  let file, type, cache = 'no-cache';
  if (STATIC[url.pathname]) [file, type] = STATIC[url.pathname];
  else {
    const m = /^\/images\/([\w.-]+)\.(\w+)$/.exec(url.pathname);
    if (m && IMG_TYPES[m[2].toLowerCase()]) { file = path.join('images', m[1] + '.' + m[2]); type = IMG_TYPES[m[2].toLowerCase()]; cache = 'public, max-age=86400'; }
  }
  if (!file) { res.writeHead(404, Object.assign(headers, { 'Content-Type': 'text/plain; charset=utf-8' })); res.end('Introuvable'); return; }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404, headers); res.end('Introuvable'); return; }
    res.writeHead(200, Object.assign(headers, { 'Content-Type': type, 'Cache-Control': cache }));
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function err(ws, message, extra) { send(ws, Object.assign({ type: 'error', message }, extra || {})); }

// Codes de salon sans caractères ambigus (0/O, 1/I...).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
const hooks = { send, official };

// Ne garde que les champs connus d'une action venue du réseau.
function cleanAction(a) {
  if (!a || typeof a.type !== 'string') return null;
  const out = { type: a.type.slice(0, 32) };
  if ('pos' in a) out.pos = Number(a.pos);
  if ('amount' in a) out.amount = Number(a.amount);
  if ('to' in a) out.to = Number(a.to);
  const side = x => (x && typeof x === 'object') ? { money: Number(x.money) || 0, props: Array.isArray(x.props) ? x.props.slice(0, 40).map(Number) : [], getOut: Number(x.getOut) || 0 } : undefined;
  if ('give' in a) out.give = side(a.give);
  if ('get' in a) out.get = side(a.get);
  return out;
}

// Anti-inondation : 40 messages d'affilée, puis 20 par seconde.
function allow(ws) {
  const now = Date.now();
  ws.bucket = Math.min(40, (ws.bucket ?? 40) + ((now - (ws.bucketAt || now)) / 1000) * 20);
  ws.bucketAt = now;
  if (ws.bucket < 1) return false;
  ws.bucket -= 1;
  return true;
}

function joinedMsg(room, seat, token) {
  return { type: 'joined', code: room.code, seat, token, host: room.hostSeat === seat, phase: room.phase, protocol: PROTOCOL, ephemeralSaves: snap.isEphemeral() };
}
function sendRoomState(ws, room) {
  if (room.phase === 'lobby') send(ws, room.lobbyView());
  else send(ws, room.fullGameMsg());
}

function handle(ws, msg) {
  const room = ws.room || null;
  const seat = ws.seat;
  const isHost = room && room.hostSeat === seat;
  switch (msg.type) {
    case 'ping': send(ws, { type: 'pong', t: msg.t }); return;

    case 'create_room': {
      if (room) return err(ws, 'Vous êtes déjà dans un salon.');
      const code = newCode();
      const r = new Room(code, hooks);
      rooms.set(code, r);
      const { seat: s, token } = r.addSeat(msg.name, msg.pawn);
      r.hostSeat = s;
      r.attach(s, ws);
      send(ws, joinedMsg(r, s, token));
      r.broadcastLobby();
      log(`Salon ${code} créé par ${r.seats[s].name}`);
      return;
    }

    case 'join_room': {
      if (room) return err(ws, 'Vous êtes déjà dans un salon.');
      const r = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!r) return err(ws, 'Salon introuvable. Vérifiez le code.', { code: 'unknown_room' });
      if (r.phase === 'lobby') {
        if (r.seats.length >= 6) return err(ws, 'Salon complet (6 joueurs maximum).');
        const { seat: s, token } = r.addSeat(msg.name, msg.pawn);
        r.attach(s, ws);
        send(ws, joinedMsg(r, s, token));
        r.broadcastLobby();
        return;
      }
      // Partie en cours : seules les places libérées par l'hôte peuvent être reprises.
      const free = r.seats.map((s, i) => ({ seat: i, name: s.name, pawn: r.pawnRef(i), claimable: s.claimable && !s.connected })).filter(x => x.claimable);
      if (!free.length) return err(ws, 'La partie a déjà commencé. Si vous en faites partie, utilisez « Reprendre une partie en ligne » ; depuis un autre appareil, demandez à l\'hôte de libérer votre place.');
      const want = Number(msg.claim);
      if (!free.some(f => f.seat === want)) { send(ws, { type: 'claim_list', code: r.code, seats: free }); return; }
      const token = r.reissue(want);
      r.attach(want, ws);
      send(ws, joinedMsg(r, want, token));
      send(ws, r.fullGameMsg());
      r.broadcastSystemChat(`${r.seats[want].name} reprend sa place.`);
      r.broadcastMeta();
      return;
    }

    case 'resume': {
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) return send(ws, { type: 'resume_failed', code: msg.code, reason: 'unknown_room' });
      const s = r.seatByToken(msg.token);
      if (s < 0) return send(ws, { type: 'resume_failed', code: msg.code, reason: 'unknown_seat' });
      if (room && room !== r) room.detach(ws);
      r.attach(s, ws);
      send(ws, joinedMsg(r, s, msg.token));
      sendRoomState(ws, r);
      if (r.phase === 'lobby') r.broadcastLobby(); else r.broadcastMeta();
      return;
    }

    case 'restore': {
      const p = snap.open(msg.snapshot);
      if (!p) return err(ws, 'Sauvegarde illisible ou modifiée (ou faite sur un autre serveur).', { code: 'bad_snapshot' });
      const board = msg.board && (msg.board.board || msg.board);
      const cards = E.normalizeCards(msg.cards);
      const pawns = Array.isArray(msg.pawns) ? msg.pawns : null;
      if (snap.hashJson(board) !== p.boardHash || snap.hashJson(cards) !== p.cardsHash || snap.hashJson(pawns) !== p.pawnsHash) {
        return err(ws, 'Le plateau, les cartes ou les pions ne correspondent pas à cette sauvegarde.', { code: 'bad_snapshot' });
      }
      const existing = rooms.get(p.code);
      if (existing) {
        // Deux joueurs peuvent revenir en même temps : on garde la sauvegarde
        // la plus récente, tant que personne n'a encore rejoué depuis la restauration.
        const untouched = existing.restoredAt && existing.state && existing.state.seq === existing.restoredSeq;
        if (!untouched || existing.state.seq >= p.state.seq) return send(ws, { type: 'restored', code: p.code, already: true });
        const nr = Room.fromSnapshot(p, board, cards, pawns, hooks);
        rooms.set(p.code, nr);
        existing.seats.forEach((s, i) => { if (s.ws && nr.seats[i]) nr.attach(i, s.ws); });
        nr.broadcast(nr.fullGameMsg());
      } else {
        rooms.set(p.code, Room.fromSnapshot(p, board, cards, pawns, hooks));
      }
      log(`Salon ${p.code} restauré (coup ${p.state.seq})`);
      send(ws, { type: 'restored', code: p.code });
      return;
    }
  }

  // ── Messages qui demandent d'être dans un salon ──
  if (!room) return err(ws, 'Rejoignez d\'abord un salon.');
  switch (msg.type) {
    case 'leave': {
      if (room.phase === 'lobby') {
        room.removeLobbySeat(seat);
        ws.room = null; ws.seat = null;
        if (!room.seats.length) rooms.delete(room.code); else room.broadcastLobby();
      } else {
        room.detach(ws);
        ws.room = null; ws.seat = null;
      }
      return;
    }
    case 'lobby_me':
      if (room.phase !== 'lobby') return;
      if ('name' in msg) room.seats[seat].name = clampName(msg.name, room.seats[seat].name);
      if ('pawn' in msg) {
        const p = cleanPawn(msg.pawn);
        if (room.pawnTaken(p, seat)) { err(ws, 'Ce pion est déjà pris par un autre joueur.'); room.broadcastLobby(); return; }
        room.seats[seat].pawn = p;
      }
      room.broadcastLobby();
      return;
    case 'lobby_config':
      if (!isHost || room.phase !== 'lobby') return err(ws, "Seul l'hôte peut régler la partie.");
      room.setConfig(msg.config);
      room.broadcastLobby();
      return;
    case 'lobby_data': {
      if (!isHost || room.phase !== 'lobby') return err(ws, "Seul l'hôte peut changer le plateau.");
      const e = room.setData(msg.board, msg.cards);
      if (e) return err(ws, e);
      room.broadcastLobby();
      return;
    }
    case 'kick_lobby':
      if (!isHost || room.phase !== 'lobby') return;
      if (msg.seat === seat || !room.seats[msg.seat]) return;
      { const w = room.seats[msg.seat].ws; room.removeLobbySeat(msg.seat); if (w) { w.room = null; w.seat = null; send(w, { type: 'kicked' }); } }
      room.broadcastLobby();
      return;
    case 'start': {
      if (!isHost) return err(ws, "Seul l'hôte peut lancer la partie.");
      if (room.phase !== 'lobby') return;
      let e;
      try { e = room.start(); } catch (ex) { e = 'Impossible de lancer : ' + ex.message; }
      if (e) err(ws, e); else log(`Partie lancée dans ${room.code} (${room.seats.length} joueurs)`);
      return;
    }
    case 'act': {
      const a = cleanAction(msg.action);
      if (!a) return err(ws, 'Action invalide.');
      if (room.seats[seat].removed) return err(ws, 'Vous avez été retiré de la partie.');
      const e = room.act(seat, a);
      if (e) err(ws, e, { refused: a.type });
      return;
    }
    case 'presence':
      if (room.phase !== 'playing') return;
      room.setAway(seat, !!msg.away);
      return;
    case 'host': {
      const e = room.hostCommand(seat, String(msg.cmd || ''), Number(msg.seat), msg.value);
      if (e) err(ws, e);
      return;
    }
    case 'chat':
      if (!ws.chatAt || Date.now() - ws.chatAt > 400) { ws.chatAt = Date.now(); room.addChat(seat, msg.text); }
      return;
    case 'sync':
      sendRoomState(ws, room);
      return;
    default:
      err(ws, 'Message inconnu.');
  }
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    ws.isAlive = true;
    if (!allow(ws)) return err(ws, 'Trop de messages, ralentissez.');
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return err(ws, 'Message illisible.'); }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error(e); err(ws, 'Erreur serveur.'); }
  });
  ws.on('close', () => { if (ws.room) ws.room.detach(ws); });
  send(ws, { type: 'hello', protocol: PROTOCOL });
});

// Battement de cœur : une connexion qui ne répond plus à deux pings d'affilée
// (~30 s) est coupée, ce qui marque le joueur comme déconnecté.
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 15000);

// Horloge des salons + ménage des salons vides.
const clock = setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    try { r.tick(now); } catch (e) { console.error('tick', code, e); }
    const idle = r.emptySince ? now - r.emptySince : 0;
    const limit = r.phase === 'lobby' ? 10 * 60000 : r.phase === 'ended' ? 15 * 60000 : 60 * 60000;
    const neverJoined = !r.emptySince && !r.seats.some(s => s.connected) && now - r.createdAt > 10 * 60000;
    if ((r.emptySince && idle > limit) || neverJoined) { rooms.delete(code); log(`Salon ${code} fermé (vide)`); }
  }
}, 1000);

function log(m) { if (!process.env.QUIET) console.log(new Date().toISOString().slice(11, 19), m); }

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`✅ Monopoly KJ sur http://localhost:${PORT}  (jeu servi depuis ${ROOT})`);
    if (snap.isEphemeral()) console.warn('⚠️  SNAPSHOT_SECRET absent : les sauvegardes ne survivront pas à un redémarrage du serveur. Ajoutez cette variable dans les réglages Render.');
  });
}

module.exports = { server, rooms, stop: () => { clearInterval(heartbeat); clearInterval(clock); wss.clients.forEach(c => c.terminate()); wss.close(); server.close(); server.closeAllConnections(); } };
