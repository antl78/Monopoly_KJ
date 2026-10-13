// ════════════════════════════════════════════════════════════════════════════
// room.js — Un salon : lobby, places, partie, présence, minuteurs, sauvegarde
// ────────────────────────────────────────────────────────────────────────────
// Le serveur ne contient AUCUNE règle de jeu : il demande tout au moteur
// partagé (../engine.js). Son rôle : savoir qui est qui, qui est là, qui on
// attend, et relayer les mises à jour à tout le monde.
//
// Présence (voir claude/plan-multijoueur.md) :
//   • déconnecté  : la partie l'attend GRACE_MS ; après, l'hôte choisit
//                   Attendre / Jouer en auto / Retirer ;
//   • inactif     : minuteur par décision (réglable, 0 = désactivé) ; à la fin,
//                   une action prudente est jouée à sa place ; deux fois de
//                   suite sans réaction → il passe « absent » automatiquement ;
//   • volontaire  : « Je m'absente » (tours joués en auto prudent), pause de
//                   l'hôte (tout est gelé), « Abandonner ».
// ════════════════════════════════════════════════════════════════════════════
const E = require('../engine.js');
const snap = require('./snapshot.js');

const GRACE_MS = 120000;        // déconnexion : la partie attend 2 minutes
const AUCTION_MS = 15000;       // enchère : adjugée 15 s après la dernière offre
const AUTO_DELAY_MS = 1200;     // rythme des coups joués automatiquement
const SNAPSHOT_EVERY_MS = 1000;      // sauvegarde au plus tard 1 s après un coup
const TIMER_CHOICES = [0, 30, 60, 90, 120, 180, 300];
const CHAT_KEEP = 60;

const PAWN_EMOJIS = ['🎩','🚂','🐕','🚗','⛵','👢','🎸','🍕','🐉','🦊','🤖','🌸'];
function clampName(n, fallback) { const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24); return s || fallback; }
function cleanPawn(p) {
  if (typeof p !== 'string' || !p) return '🎩';
  if (p.startsWith('data:image/')) return p.length <= 120000 ? p : '🎩';
  if (/^https?:\/\//i.test(p)) return p.length <= 500 ? p : '🎩';
  return [...p].slice(0, 4).join('');
}

class Room {
  constructor(code, hooks) {
    this.code = code;
    this.hooks = hooks;               // { send(ws, msg), official() → {board, cards} }
    this.seats = [];
    this.hostSeat = 0;
    this.phase = 'lobby';             // lobby | playing | ended
    this.config = { startMoney: 1500, auctions: true, evenBuild: true, buildingLimit: false };
    this.timerSec = 120;
    this.customBoard = null;
    this.customCards = null;
    this.state = null;
    this.board = null; this.cards = null;
    // Pions en image : envoyés UNE fois (comme le plateau) ; dans l'état de
    // jeu, le pion devient une simple référence « img:N ».
    this.pawns = null;
    this.boardHash = null; this.cardsHash = null; this.pawnsHash = null;
    this.paused = false;
    this.deadline = null;             // fin du minuteur de la décision en cours
    this.frozenLeft = null;           // temps restant gelé pendant une pause
    this.auctionDeadline = null;
    this.lastChangeAt = Date.now();
    this.lastSnapshotAt = 0;
    this.snapshotDirty = false;
    this.chat = [];
    this.emptySince = null;
    this.restoredAt = null;
    this.createdAt = Date.now();
  }

  // ── Places ───────────────────────────────────────────────────────────────
  // Un pion emoji ne peut être pris que par un seul joueur (sinon on ne s'y retrouve plus sur le plateau).
  pawnTaken(pawn, exceptSeat) { return !pawn.startsWith('data:') && this.seats.some((x, i) => i !== exceptSeat && x.pawn === pawn); }
  addSeat(name, pawn) {
    const token = snap.newToken();
    const seat = this.seats.length;
    let p = cleanPawn(pawn);
    if (this.pawnTaken(p, -1)) p = PAWN_EMOJIS.find(e => !this.pawnTaken(e, -1)) || p;
    this.seats.push({ name: clampName(name, 'Joueur ' + (seat + 1)), pawn: p, tokenHash: snap.hashToken(token),
      ws: null, connected: false, disconnectedAt: Date.now(), away: false, auto: false, waitForever: false,
      removed: false, claimable: false, needsDecision: false, timeouts: 0 });
    return { seat, token };
  }
  seatByToken(token) { const h = snap.hashToken(token); return this.seats.findIndex(s => s.tokenHash === h); }
  // Donne une nouvelle clé à une place libérée par l'hôte (joueur qui a changé d'appareil).
  reissue(seat) { const token = snap.newToken(); this.seats[seat].tokenHash = snap.hashToken(token); this.seats[seat].claimable = false; return token; }

  attach(seat, ws) {
    const s = this.seats[seat];
    if (s.ws && s.ws !== ws) { try { this.hooks.send(s.ws, { type: 'replaced' }); s.ws.close(4000, 'replaced'); } catch (e) { /* déjà fermé */ } }
    s.ws = ws; s.connected = true; s.needsDecision = false; s.disconnectedAt = null;
    ws.room = this; ws.seat = seat;
    this.emptySince = null;
  }
  detach(ws) {
    const s = this.seats[ws.seat];
    if (!s || s.ws !== ws) return;
    s.ws = null; s.connected = false; s.disconnectedAt = Date.now();
    if (!this.seats.some(x => x.connected)) this.emptySince = Date.now();
    if (this.phase === 'lobby') this.broadcastLobby(); else this.broadcastMeta();
  }
  removeLobbySeat(seat) {
    this.seats.splice(seat, 1);
    this.seats.forEach((s, i) => { if (s.ws) s.ws.seat = i; });
    if (this.hostSeat === seat || this.hostSeat >= this.seats.length) this.hostSeat = Math.max(0, this.seats.findIndex(s => s.connected));
    else if (this.hostSeat > seat) this.hostSeat--;
  }

  // ── Envois ───────────────────────────────────────────────────────────────
  sendTo(seat, msg) { const s = this.seats[seat]; if (s && s.ws) this.hooks.send(s.ws, msg); }
  broadcast(msg) { this.seats.forEach(s => { if (s.ws) this.hooks.send(s.ws, msg); }); }

  lobbyView() {
    return { type: 'lobby', code: this.code, hostSeat: this.hostSeat, config: this.config, timerSec: this.timerSec,
      customBoard: !!this.customBoard, customCards: !!this.customCards,
      seats: this.seats.map((s, i) => ({ seat: i, name: s.name, pawn: s.pawn, connected: s.connected })) };
  }
  broadcastLobby() { this.broadcast(this.lobbyView()); }

  meta(now) {
    now = now || Date.now();
    const awaiting = this.state ? E.awaiting(this.state) : [];
    return {
      hostSeat: this.hostSeat, paused: this.paused, timerSec: this.timerSec,
      timerLeft: this.paused ? this.frozenLeft : (this.deadline ? Math.max(0, this.deadline - now) : null),
      auctionLeft: this.auctionDeadline ? Math.max(0, this.auctionDeadline - now) : null,
      awaiting,
      seats: this.seats.map((s, i) => ({ seat: i, name: s.name, pawn: this.pawnRef(i), connected: s.connected, away: s.away, auto: s.auto,
        removed: s.removed, claimable: s.claimable, needsDecision: s.needsDecision, waitForever: s.waitForever,
        graceLeft: !s.connected && s.disconnectedAt ? Math.max(0, GRACE_MS - (now - s.disconnectedAt)) : null })),
    };
  }
  pawnRef(i) { const p = this.seats[i].pawn; return this.phase !== 'lobby' && p.startsWith('data:') ? 'img:' + i : p; }
  broadcastMeta() { if (this.phase !== 'lobby') this.broadcast({ type: 'meta', meta: this.meta() }); }

  // État envoyé aux joueurs : sans la partie secrète, sans le plateau/les cartes
  // (envoyés une seule fois, au démarrage, car lourds avec les images).
  view() { const { board, cards, ...rest } = E.publicView(this.state); return rest; }
  fullGameMsg() {
    return { type: 'game', code: this.code, v: this.state.seq, board: this.board, cards: this.cards, pawns: this.pawns, state: this.view(), meta: this.meta(), chat: this.chat };
  }

  // ── Lobby ────────────────────────────────────────────────────────────────
  setConfig(c) {
    if (!c || typeof c !== 'object') return;
    const sm = parseInt(c.startMoney, 10);
    if (Number.isInteger(sm)) this.config.startMoney = Math.min(100000, Math.max(100, sm));
    ['auctions', 'evenBuild', 'buildingLimit'].forEach(k => { if (k in c) this.config[k] = !!c[k]; });
    if ('timerSec' in c && TIMER_CHOICES.includes(Number(c.timerSec))) this.timerSec = Number(c.timerSec);
  }
  setData(board, cards) {
    if (board !== undefined) {
      if (board === null) this.customBoard = null;
      else { const b = board.board || board; const err = E.validateBoard(b); if (err) return err; this.customBoard = b; }
    }
    if (cards !== undefined) this.customCards = cards === null ? null : E.normalizeCards(cards);
    return null;
  }

  start() {
    if (this.seats.length < 2) return '2 joueurs minimum.';
    const off = this.hooks.official();
    this.board = this.customBoard || off.board;
    this.cards = this.customCards || off.cards;
    const err = E.validateBoard(this.board);
    if (err) return 'Plateau invalide : ' + err;
    this.pawns = this.seats.map(s => s.pawn.startsWith('data:') ? s.pawn : null);
    this.state = E.createGame({ board: this.board, cards: this.cards, config: this.config,
      players: this.seats.map((s, i) => ({ name: s.name, pawn: this.pawns[i] ? 'img:' + i : s.pawn })) });
    this.boardHash = snap.hashJson(this.board);
    this.cardsHash = snap.hashJson(this.cards);
    this.pawnsHash = snap.hashJson(this.pawns);
    this.phase = 'playing';
    this.touch();
    this.broadcast(this.fullGameMsg());
    this.sendSnapshot(true);
    return null;
  }

  // ── Partie ───────────────────────────────────────────────────────────────
  touch() {
    const now = Date.now();
    this.lastChangeAt = now;
    this.deadline = this.timerSec > 0 ? now + this.timerSec * 1000 : null;
    const pd = this.state && this.state.pending;
    this.auctionDeadline = pd && pd.type === 'auction' ? now + AUCTION_MS : null;
  }

  // Applique une action d'un joueur (ou 'system') et diffuse le résultat.
  act(seat, action, opts) {
    if (this.phase !== 'playing' || !this.state) return 'Aucune partie en cours.';
    if (this.paused && !(opts && opts.evenIfPaused)) return 'La partie est en pause.';
    const r = E.apply(this.state, seat, action);
    if (!r.ok) return r.error;
    this.state = r.state;
    if (seat !== 'system' && !(opts && opts.auto)) { const s = this.seats[seat]; if (s) s.timeouts = 0; }
    this.touch();
    this.snapshotDirty = true;
    const msg = { type: 'update', v: this.state.seq, events: r.events, state: this.view(), meta: this.meta(), by: seat, auto: !!(opts && opts.auto) };
    this.broadcast(msg);
    if (this.state.phase === 'ended') { this.phase = 'ended'; this.sendSnapshot(true); }
    else if (r.events.some(e => e.t === 'turn')) this.sendSnapshot(true);
    return null;
  }

  // Joue l'action prudente par défaut pour `seat` (absent, auto, minuteur).
  autoPlay(seat) {
    let a;
    if (this.state.trade && this.state.trade.to === seat) a = { type: 'trade_reject' };
    else a = E.autoAction(this.state, seat);
    if (!a) return false;
    return this.act(seat, a, { auto: true }) === null;
  }

  // Appelée chaque seconde.
  tick(now) {
    if (this.phase === 'lobby' && this.hostSeat >= 0 && this.seats[this.hostSeat] && !this.seats[this.hostSeat].connected) this.maybeMoveHost(now);
    if (this.phase !== 'playing' || !this.state) return;
    this.maybeMoveHost(now);
    this.maybeSnapshot(now);
    if (this.paused) return;
    const st = this.state;
    const awaited = E.awaiting(st);
    const tradeTo = st.trade ? st.trade.to : null;
    const concerned = tradeTo !== null && !awaited.includes(tradeTo) ? awaited.concat([tradeTo]) : awaited;

    // 1. Places en auto / absentes / retirées : on joue pour elles, à rythme lisible.
    if (now - this.lastChangeAt >= AUTO_DELAY_MS) {
      for (const seat of concerned) {
        const s = this.seats[seat];
        if (s && (s.auto || s.away || s.removed) && this.autoPlay(seat)) return;
      }
    }
    // 2. Enchère : adjugée après AUCTION_MS sans nouvelle offre.
    if (this.auctionDeadline && now >= this.auctionDeadline && st.pending && st.pending.type === 'auction') {
      this.act('system', { type: 'auction_timeout' });
      return;
    }
    // 3. Déconnexions : après la période de grâce, l'hôte doit décider.
    let changed = false;
    for (const seat of concerned) {
      const s = this.seats[seat];
      if (s && !s.connected && !s.waitForever && !s.auto && !s.removed && !s.needsDecision && now - s.disconnectedAt >= GRACE_MS) {
        s.needsDecision = true; changed = true;
      }
    }
    if (changed) this.broadcastMeta();
    // 4. Minuteur de décision (joueurs connectés seulement).
    if (this.deadline && now >= this.deadline) {
      for (const seat of concerned) {
        const s = this.seats[seat];
        if (!s || !s.connected || s.away || s.auto) continue;
        s.timeouts++;
        const name = s.name;
        if (this.autoPlay(seat)) {
          if (s.timeouts >= 2) { s.away = true; this.broadcastSystemChat(`${name} ne répond plus : il passe en mode absent (ses tours sont joués prudemment jusqu'à son retour).`); this.broadcastMeta(); }
          return;
        }
      }
      this.deadline = null;
    }
  }

  // Si l'hôte est parti depuis plus de GRACE_MS, le rôle passe au joueur connecté suivant.
  maybeMoveHost(now) {
    const h = this.seats[this.hostSeat];
    if (h && (h.connected || now - (h.disconnectedAt || now) < GRACE_MS) && !h.removed) return;
    const next = this.seats.findIndex(s => s.connected && !s.removed);
    if (next >= 0 && next !== this.hostSeat) {
      this.hostSeat = next;
      this.broadcastSystemChat(`${this.seats[next].name} devient l'hôte du salon.`);
      if (this.phase === 'lobby') this.broadcastLobby(); else this.broadcastMeta();
    }
  }

  // ── Commandes ────────────────────────────────────────────────────────────
  setAway(seat, away) {
    const s = this.seats[seat];
    s.away = !!away; s.timeouts = 0;
    this.broadcastSystemChat(away ? `${s.name} s'absente : ses tours seront joués prudemment.` : `${s.name} est de retour !`);
    this.touch();
    this.broadcastMeta();
  }

  hostCommand(seat, cmd, target, value) {
    if (seat !== this.hostSeat) return "Seul l'hôte peut faire ça.";
    const t = this.seats[target];
    const now = Date.now();
    switch (cmd) {
      case 'pause':
        if (this.phase !== 'playing' || this.paused) return null;
        this.paused = true; this.frozenLeft = this.deadline ? Math.max(0, this.deadline - now) : null;
        this.broadcastSystemChat('⏸️ Partie en pause.');
        break;
      case 'resume':
        if (!this.paused) return null;
        this.paused = false;
        this.deadline = this.frozenLeft !== null ? now + this.frozenLeft : (this.timerSec ? now + this.timerSec * 1000 : null);
        if (this.auctionDeadline) this.auctionDeadline = now + AUCTION_MS;
        this.frozenLeft = null; this.lastChangeAt = now;
        this.broadcastSystemChat('▶️ La partie reprend !');
        break;
      case 'wait': if (!t) return 'Place inconnue.'; t.waitForever = true; t.needsDecision = false; break;
      case 'auto': if (!t) return 'Place inconnue.'; t.auto = true; t.needsDecision = false; this.broadcastSystemChat(`${t.name} est joué automatiquement (prudemment).`); break;
      case 'unauto': if (!t) return 'Place inconnue.'; t.auto = false; break;
      case 'remove': {
        if (!t || t.removed) return 'Place inconnue.';
        const err = this.act('system', { type: 'resign', player: target }, { evenIfPaused: true });
        if (err) return err;
        t.removed = true; t.needsDecision = false;
        break;
      }
      case 'free_seat':
        if (!t || t.connected) return 'Cette place est occupée.';
        t.claimable = true;
        this.broadcastSystemChat(`La place de ${t.name} peut être reprise : il suffit de rejoindre avec le code ${this.code}.`);
        break;
      case 'timer':
        if (!TIMER_CHOICES.includes(Number(value))) return 'Durée invalide.';
        this.timerSec = Number(value); this.touch();
        break;
      case 'end_by_worth': {
        const err = this.act('system', { type: 'end_by_worth' }, { evenIfPaused: true });
        if (err) return err;
        this.paused = false;
        break;
      }
      default: return 'Commande inconnue.';
    }
    this.broadcastMeta();
    return null;
  }

  // ── Chat ─────────────────────────────────────────────────────────────────
  addChat(seat, text) {
    const t = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 300);
    if (!t) return;
    const s = this.seats[seat];
    const m = { seat, name: s.name, pawn: s.pawn.startsWith('data:') ? null : s.pawn, text: t, ts: Date.now() };
    this.chat.push(m); if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.broadcast({ type: 'chat', msg: m });
  }
  broadcastSystemChat(text) {
    const m = { seat: null, name: null, text, ts: Date.now() };
    this.chat.push(m); if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.broadcast({ type: 'chat', msg: m });
  }

  // ── Sauvegarde ───────────────────────────────────────────────────────────
  snapshotPayload() {
    const { board, cards, ...state } = this.state;
    return { code: this.code, savedAt: Date.now(), state, boardHash: this.boardHash, cardsHash: this.cardsHash, pawnsHash: this.pawnsHash,
      hostSeat: this.hostSeat, timerSec: this.timerSec,
      seats: this.seats.map((s, i) => ({ name: s.name, pawn: this.pawnRef(i), tokenHash: s.tokenHash, away: s.away, auto: s.auto, removed: s.removed })) };
  }
  sendSnapshot(force) {
    if (!this.state) return;
    this.snapshotDirty = false; this.lastSnapshotAt = Date.now();
    this.broadcast({ type: 'snapshot', code: this.code, v: this.state.seq, blob: snap.seal(this.snapshotPayload()), ended: this.phase === 'ended' });
  }
  maybeSnapshot(now) { if (this.snapshotDirty && now - this.lastSnapshotAt >= SNAPSHOT_EVERY_MS) this.sendSnapshot(); }

  // Recrée un salon à partir d'une sauvegarde (déjà déchiffrée et vérifiée).
  static fromSnapshot(p, board, cards, pawns, hooks) {
    const r = new Room(p.code, hooks);
    r.phase = p.state.phase === 'ended' ? 'ended' : 'playing';
    r.board = board; r.cards = cards; r.pawns = pawns;
    r.boardHash = p.boardHash; r.cardsHash = p.cardsHash; r.pawnsHash = p.pawnsHash;
    r.state = Object.assign({}, p.state, { board, cards });
    r.config = Object.assign({}, r.state.config);
    r.hostSeat = p.hostSeat || 0; r.timerSec = TIMER_CHOICES.includes(p.timerSec) ? p.timerSec : 120;
    r.seats = p.seats.map((s, i) => ({ name: s.name, pawn: pawns && pawns[i] ? pawns[i] : s.pawn, tokenHash: s.tokenHash, ws: null, connected: false,
      disconnectedAt: Date.now(), away: !!s.away, auto: !!s.auto, waitForever: false, removed: !!s.removed,
      claimable: false, needsDecision: false, timeouts: 0 }));
    r.restoredAt = Date.now();
    r.restoredSeq = r.state.seq;
    r.touch();
    r.chat.push({ seat: null, name: null, text: '💾 Partie restaurée depuis la dernière sauvegarde.', ts: Date.now() });
    return r;
  }
}

module.exports = { Room, GRACE_MS, AUCTION_MS, TIMER_CHOICES, cleanPawn, clampName };
