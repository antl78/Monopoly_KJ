/* ════════════════════════════════════════════════════════════════════════════
   engine.js — Moteur de règles de Monopoly KJ
   ────────────────────────────────────────────────────────────────────────────
   UN SEUL moteur pour tout le jeu :
     • en solo, monopoly-game.html le charge avec <script src="engine.js">
       (fonctionne aussi en double-clic / file://) ;
     • en ligne, le serveur (monopoly-server/server.js) le charge avec require().

   Le moteur est « pur » : pas de DOM, pas d'animation, pas de réseau.
   On lui donne un état + une action, il rend un NOUVEL état + la liste des
   événements à animer (dés, marche du pion, carte, journal...) :

       const r = MonoEngine.apply(state, joueurId, {type:'roll'});
       if (r.ok) { state = r.state; animer(r.events); } else afficher(r.error);

   L'état est un objet JSON simple (sérialisable tel quel pour la sauvegarde).
   Le hasard (dés, mélange des paquets) vient d'un générateur à graine rangé
   dans state.secret : même graine + mêmes actions = même partie. state.secret
   (graine + ordre des paquets) n'est JAMAIS envoyé aux joueurs en ligne — voir
   publicView().

   Attentes explicites : quand le jeu attend une décision précise, elle est
   écrite dans l'état (state.pending, state.debts, state.trade). C'est ce qui
   permet au serveur de savoir QUI il attend, et à l'interface d'afficher la
   bonne fenêtre, même après un rafraîchissement de page.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonoEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 1;
  const GO_SALARY = 200;
  const JAIL_FINE = 50;
  const MAX_LOG = 200;
  const CURRENCY = 'oufingoufs';
  const BUYABLE = ['property', 'station', 'utility'];

  const DEFAULT_CONFIG = {
    startMoney: 1500,
    auctions: true,        // enchère quand le joueur refuse d'acheter
    evenBuild: true,       // construction/vente homogène dans un groupe
    buildingLimit: false,  // pénurie : stock limité d'alertes / alerteprisons
    houses: 32,            // stock d'alertes si buildingLimit
    hotels: 12,            // stock d'alerteprisons si buildingLimit
  };

  // ── Petits outils ────────────────────────────────────────────────────────
  // Un pion est un emoji, une image (data:/http), ou en ligne une référence
  // « img:N » vers une image envoyée une seule fois au début de la partie.
  function isImagePawn(v) { return typeof v === 'string' && /^(https?:\/\/|data:image|img:)/i.test(v); }
  function pawnChar(p) { return p && isImagePawn(p.pawn) ? '🔹' : (p ? p.pawn : ''); }
  function who(p) { return `${pawnChar(p)} ${p.name}`; }
  function isInt(n) { return Number.isInteger(n); }

  // Générateur pseudo-aléatoire mulberry32 : la graine avance dans state.secret.
  function rand(ctx) {
    if (ctx.opts.rng) return ctx.opts.rng();
    const sec = ctx.s.secret;
    let t = (sec.seed = (sec.seed + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffled(ctx, n) {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand(ctx) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // Copie profonde de l'état, SAUF le plateau et les cartes : ils ne changent
  // jamais pendant la partie (et pèsent lourd avec les images en base64), on
  // garde donc la même référence au lieu de les recopier à chaque action.
  // Le journal est copié « en surface » : ses lignes ne sont jamais modifiées.
  function cloneState(s) {
    const { board, cards, log, ...rest } = s;
    const c = JSON.parse(JSON.stringify(rest));
    c.board = board; c.cards = cards; c.log = log.slice();
    return c;
  }

  // ── Lecture de l'état (utilisées aussi par l'interface) ─────────────────
  function cell(s, pos) { return s.board[pos]; }
  function player(s, id) { return s.players[id]; }
  function ownerOf(s, pos) { return s.players.find(p => !p.bankrupt && p.properties.includes(pos)) || null; }
  function isMortgaged(s, pos) { return s.mortgaged.includes(pos); }
  function bld(s, pos) { return s.buildings[pos] || { houses: 0, hotel: 0 }; }
  function level(s, pos) { const b = bld(s, pos); return b.hotel ? 5 : b.houses; }
  function groupCells(s, group) { return s.board.filter(c => c.type === 'property' && c.group === group); }
  function ownsGroup(s, pid, group) {
    const g = groupCells(s, group);
    return g.length > 0 && g.every(c => s.players[pid].properties.includes(c.pos));
  }
  function groupHasBuildings(s, group) { return groupCells(s, group).some(c => level(s, c.pos) > 0); }
  function jailPos(s) { const i = s.board.findIndex(c => c.type === 'jail'); return i >= 0 ? i : 10; }
  function unmortgageCost(c) { return Math.round(c.mortgage * 1.1); }
  function housesInPlay(s) { let n = 0; for (const k in s.buildings) n += s.buildings[k].houses || 0; return n; }
  function hotelsInPlay(s) { let n = 0; for (const k in s.buildings) n += s.buildings[k].hotel ? 1 : 0; return n; }
  function housesLeft(s) { return s.config.buildingLimit ? s.config.houses - housesInPlay(s) : Infinity; }
  function hotelsLeft(s) { return s.config.buildingLimit ? s.config.hotels - hotelsInPlay(s) : Infinity; }
  function hasDebt(s, pid) { return s.debts.some(d => d.from === pid); }
  function alive(s) { return s.players.filter(p => !p.bankrupt); }

  // Loyer dû par un joueur qui tombe sur `pos` (0 si pas de loyer).
  function rentFor(s, pos, diceTotal) {
    const c = cell(s, pos);
    const owner = ownerOf(s, pos);
    if (!c || !owner || isMortgaged(s, pos)) return 0;
    if (c.type === 'station') {
      const n = owner.properties.filter(q => s.board[q] && s.board[q].type === 'station').length;
      return c.rents[Math.min(n - 1, 3)] || 25;
    }
    if (c.type === 'utility') {
      const n = owner.properties.filter(q => s.board[q] && s.board[q].type === 'utility').length;
      const d = diceTotal || (s.dice ? s.dice[0] + s.dice[1] : 7);
      return n >= 2 ? d * 10 : d * 4;
    }
    const b = bld(s, pos);
    if (b.hotel) return c.rents[5];
    if (b.houses > 0) return c.rents[b.houses];
    return ownsGroup(s, owner.id, c.group) ? c.rents[0] * 2 : c.rents[0];
  }

  // Patrimoine : argent + valeur des biens (hypothéqués à leur valeur
  // d'hypothèque) + alertes au prix d'achat. Sert au classement de fin.
  function netWorth(s, pid) {
    const p = s.players[pid];
    let w = p.money;
    p.properties.forEach(pos => {
      const c = cell(s, pos);
      w += isMortgaged(s, pos) ? c.mortgage : c.price;
      w += level(s, pos) * (c.buildCost || 0);
    });
    return w;
  }

  // Qui doit agir maintenant ? (hors échange, qui a sa propre attente)
  function awaiting(s) {
    if (s.phase === 'ended') return [];
    if (s.debts.length) return [s.debts[0].from];
    const pd = s.pending;
    if (pd && pd.type === 'auction') {
      return pd.participants.filter(id => !pd.passed.includes(id) && id !== pd.highBidder && !s.players[id].bankrupt);
    }
    if (pd) return [pd.player];
    return [s.current];
  }

  // Qui peut gérer ses biens (construire, vendre, hypothéquer) en ce moment ?
  function manager(s) {
    if (s.phase === 'ended') return null;
    if (s.debts.length) return s.debts[0].from;
    const pd = s.pending;
    if (pd && pd.type === 'buy') return pd.player;   // hypothéquer pour pouvoir acheter
    if (pd) return null;                              // enchère / choix de carte en cours
    return s.current;
  }

  // ── Création d'une partie ───────────────────────────────────────────────
  function normalizeCards(cards) {
    const c = cards || {};
    return { chance: Array.isArray(c.chance) ? c.chance : [], community: Array.isArray(c.community) ? c.community : [] };
  }

  function validateBoard(board) {
    if (!Array.isArray(board) || board.length !== 40) return 'Le plateau doit contenir exactement 40 cases.';
    for (let i = 0; i < 40; i++) {
      const c = board[i];
      if (!c || c.pos !== i) return `Case ${i} manquante ou mal numérotée.`;
      if (!Array.isArray(c.rents)) return `Case ${i} : loyers manquants.`;
    }
    return null;
  }

  function createGame(opts) {
    const board = (opts.board && opts.board.board) || opts.board;
    const berr = validateBoard(board);
    if (berr) throw new Error(berr);
    const cards = normalizeCards(opts.cards);
    const config = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    const sm = parseInt(config.startMoney, 10);
    config.startMoney = isInt(sm) ? Math.min(100000, Math.max(100, sm)) : DEFAULT_CONFIG.startMoney;
    config.auctions = !!config.auctions; config.evenBuild = !!config.evenBuild; config.buildingLimit = !!config.buildingLimit;
    config.houses = DEFAULT_CONFIG.houses; config.hotels = DEFAULT_CONFIG.hotels;
    const defs = opts.players || [];
    if (defs.length < 2 || defs.length > 6) throw new Error('Il faut entre 2 et 6 joueurs.');
    const seed = (opts.seed === undefined ? Math.floor(Math.random() * 4294967296) : opts.seed) >>> 0;
    const s = {
      schema: SCHEMA,
      config,
      board,
      cards,
      players: defs.map((d, i) => ({
        id: i, name: String(d.name || `Joueur ${i + 1}`).slice(0, 24), pawn: d.pawn || '🎩',
        money: config.startMoney, pos: 0, inJail: false, jailTurns: 0,
        getOut: [], properties: [], bankrupt: false,
      })),
      current: 0, turn: 1, phase: 'roll',
      dice: null, doublesCount: 0, noReroll: false,
      buildings: {}, mortgaged: [],
      pending: null, debts: [], trade: null,
      log: [], winner: null, endReason: null,
      seq: 0, bankNet: 0,
      secret: { seed, decks: {} },
    };
    const ctx = { s, events: [], opts: {} };
    for (const deck of ['chance', 'community']) {
      s.secret.decks[deck] = { order: shuffled(ctx, cards[deck].length), idx: 0, held: [] };
    }
    log(ctx, `Partie lancée avec ${s.players.length} joueurs !`, 'system');
    log(ctx, `${who(s.players[0])} commence.`, 'important');
    return s;
  }

  // ── Mécanique interne (ctx = {s, events, opts}) ──────────────────────────
  function log(ctx, msg, kind) {
    const e = { msg, kind: kind || '' };
    ctx.s.log.push(e);
    if (ctx.s.log.length > MAX_LOG) ctx.s.log.splice(0, ctx.s.log.length - MAX_LOG);
    ctx.events.push({ t: 'log', msg, kind: e.kind });
  }
  function emit(ctx, ev) { ctx.events.push(ev); }

  // La banque verse de l'argent (bankNet garde le compte, pour les tests).
  function bankPays(ctx, p, amount, why) {
    if (amount <= 0) return;
    p.money += amount; ctx.s.bankNet += amount;
    if (why) log(ctx, `${who(p)} reçoit ${amount} ${CURRENCY} (${why})`, 'gain');
  }

  // `from` paie `amount` à `to` (null = la banque). S'il n'a pas assez, ou a
  // déjà une dette en cours (pour garder l'ordre), une DETTE est créée : la
  // partie attend qu'il vende/hypothèque de quoi payer, ou qu'il fasse faillite.
  function pay(ctx, from, to, amount, why) {
    const s = ctx.s;
    if (amount <= 0) return true;
    if (from.money >= amount && !hasDebt(s, from.id)) {
      from.money -= amount;
      if (to) to.money += amount; else s.bankNet -= amount;
      log(ctx, `${who(from)} paye ${amount} ${CURRENCY}${to ? ' à ' + who(to) : ''}${why ? ' (' + why + ')' : ''}`, 'loss');
      return true;
    }
    s.debts.push({ from: from.id, to: to ? to.id : null, amount, why: why || '' });
    log(ctx, `${who(from)} doit ${amount} ${CURRENCY}${to ? ' à ' + who(to) : ' à la banque'}${why ? ' (' + why + ')' : ''} mais n'a que ${from.money} : il doit vendre, hypothéquer ou faire faillite.`, 'loss');
    return false;
  }

  // Règle automatiquement toute dette devenue payable (dans l'ordre de chaque débiteur).
  function settleDebts(ctx) {
    const s = ctx.s;
    const blocked = new Set();
    s.debts = s.debts.filter(d => {
      if (blocked.has(d.from)) return true;
      const p = s.players[d.from];
      if (p.bankrupt) return false;
      if (p.money >= d.amount) {
        p.money -= d.amount;
        const to = d.to === null ? null : s.players[d.to];
        if (to && !to.bankrupt) to.money += d.amount; else s.bankNet -= d.amount;
        log(ctx, `${who(p)} règle sa dette de ${d.amount} ${CURRENCY}${to ? ' à ' + who(to) : ''}.`, 'loss');
        return false;
      }
      blocked.add(d.from);
      return true;
    });
  }

  function pathFor(from, steps) {
    const dir = steps >= 0 ? 1 : -1, n = Math.abs(steps), path = [];
    let cur = from;
    for (let i = 0; i < n; i++) { cur = ((cur + dir) % 40 + 40) % 40; path.push(cur); }
    return path;
  }

  // Déplacement case par case (dés, cartes avancer/reculer).
  function walk(ctx, p, steps) {
    const path = pathFor(p.pos, steps);
    if (!path.length) { landOn(ctx, p); return; }
    const from = p.pos;
    const to = path[path.length - 1];
    emit(ctx, { t: 'move', player: p.id, from, path, kind: 'walk' });
    p.pos = to;
    // Atterrir PILE sur Départ est payé par landOn() (case 'go') : on ne paie
    // le « passage » que si 0 est traversé sans être la case d'arrivée.
    if (steps > 0 && to !== 0 && path.includes(0)) bankPays(ctx, p, GO_SALARY, 'passage par la case Départ');
    landOn(ctx, p);
  }

  // Téléportation (prison, cartes « directement ») : jamais de bonus Départ.
  function teleport(ctx, p, pos) {
    emit(ctx, { t: 'move', player: p.id, from: p.pos, path: [pos], kind: 'teleport' });
    p.pos = pos;
  }

  function goToJail(ctx, p) {
    teleport(ctx, p, jailPos(ctx.s));
    p.inJail = true; p.jailTurns = 0;
    ctx.s.doublesCount = 0;
    if (p.id === ctx.s.current) ctx.s.noReroll = true;
    log(ctx, `⛓️ ${who(p)} est envoyé au ${cell(ctx.s, jailPos(ctx.s)).name} !`, 'loss');
  }

  function landOn(ctx, p) {
    const s = ctx.s, c = cell(s, p.pos);
    if (!c) return;
    log(ctx, `${who(p)} arrive sur : ${c.name}`, 'move');
    switch (c.type) {
      case 'go': bankPays(ctx, p, GO_SALARY, 'case Départ'); break;
      case 'tax': pay(ctx, p, null, c.price, 'taxe ' + c.name); break;
      case 'goto_jail': goToJail(ctx, p); break;
      case 'chance': drawCard(ctx, p, 'chance'); break;
      case 'community': drawCard(ctx, p, 'community'); break;
      case 'property': case 'station': case 'utility': {
        const owner = ownerOf(s, c.pos);
        if (!owner) { s.pending = { type: 'buy', player: p.id, pos: c.pos }; break; }
        if (owner.id === p.id) { log(ctx, `${who(p)} est chez lui.`); break; }
        if (isMortgaged(s, c.pos)) { log(ctx, `${c.name} est hypothéquée : pas de loyer.`); break; }
        pay(ctx, p, owner, rentFor(s, c.pos), 'loyer ' + c.name);
        break;
      }
      default: log(ctx, `${who(p)} Simple visite.`);
    }
  }

  function drawCard(ctx, p, deck) {
    const s = ctx.s, cards = s.cards[deck], d = s.secret.decks[deck];
    if (!cards.length) { log(ctx, 'Paquet vide.'); return; }
    let idx = -1;
    for (let tries = 0; tries < cards.length; tries++) {
      const cand = d.order[d.idx % d.order.length]; d.idx++;
      if (!d.held.includes(cand)) { idx = cand; break; }
    }
    if (idx < 0) { log(ctx, 'Toutes les cartes de ce paquet sont en main.'); return; }
    const card = cards[idx];
    emit(ctx, { t: 'card', player: p.id, deck, card });
    log(ctx, `${who(p)} tire une carte ${deck === 'chance' ? 'Chance' : 'Communauté'} : « ${card.text} »`, 'chance');
    applyCard(ctx, p, card, deck, idx);
  }

  function applyCard(ctx, p, card, deck, idx) {
    const s = ctx.s;
    const others = alive(s).filter(o => o.id !== p.id);
    switch (card.effect) {
      case 'gain': bankPays(ctx, p, card.amount || 0, 'carte'); break;
      case 'lose': pay(ctx, p, null, card.amount || 0, 'carte'); break;
      case 'goto_jail': goToJail(ctx, p); break;
      case 'goto_direct': {
        const t = clampPos(card.targetPos);
        teleport(ctx, p, t);
        log(ctx, `${who(p)} est envoyé directement sur ${cell(s, t).name}`, 'move');
        landOn(ctx, p);
        break;
      }
      case 'get_out':
        p.getOut.push({ deck, idx });
        s.secret.decks[deck].held.push(idx);
        log(ctx, `${who(p)} garde la carte « sortie de prison ».`, 'gain');
        break;
      case 'move_to': {
        const t = clampPos(card.targetPos);
        // moveBackward (ex. « Redoublement ») : si l'aller en avant ferait le
        // tour par Départ, on recule à la place — donc jamais de bonus.
        const back = !!card.moveBackward && p.pos > t;
        const steps = back ? -(p.pos - t) : (t - p.pos + 40) % 40;
        if (steps === 0) { landOn(ctx, p); break; }
        walk(ctx, p, steps);
        break;
      }
      case 'move_by': walk(ctx, p, card.moveSteps || 0); break;
      case 'repairs': {
        let total = 0;
        p.properties.forEach(pos => { const b = bld(s, pos); total += b.houses * (card.perHouse || 0) + (b.hotel ? card.perHotel || 0 : 0); });
        if (total > 0) pay(ctx, p, null, total, 'réparations');
        else log(ctx, `${who(p)} n'a aucune alerte : rien à payer.`);
        break;
      }
      case 'birthday': case 'collect_all': {
        const amt = card.collectAmount || card.amount || 0;
        others.forEach(o => pay(ctx, o, p, amt, 'carte'));
        break;
      }
      case 'pay_all': {
        const amt = card.amount || 0;
        others.forEach(o => pay(ctx, p, o, amt, 'carte'));
        break;
      }
      case 'pay_or_chance':
        s.pending = { type: 'card_choice', player: p.id, amount: card.amount || 0 };
        break;
      default: log(ctx, `${who(p)} Carte spéciale.`, 'chance');
    }
  }
  function clampPos(v) { const n = parseInt(v, 10); return isInt(n) && n >= 0 && n < 40 ? n : 0; }

  function releaseGetOut(s, g) {
    const held = s.secret.decks[g.deck].held;
    const i = held.indexOf(g.idx);
    if (i >= 0) held.splice(i, 1);
  }

  function nextPlayer(ctx) {
    const s = ctx.s;
    s.doublesCount = 0; s.dice = null; s.noReroll = false;
    let next = s.current;
    for (let i = 0; i < s.players.length; i++) {
      next = (next + 1) % s.players.length;
      if (!s.players[next].bankrupt) break;
    }
    if (next <= s.current) s.turn++;
    s.current = next; s.phase = 'roll';
    log(ctx, `--- Tour de ${who(s.players[next])} ---`, 'system');
    emit(ctx, { t: 'turn', player: next });
  }

  function endGame(ctx, winnerId, reason) {
    const s = ctx.s;
    s.phase = 'ended'; s.winner = winnerId; s.endReason = reason;
    s.pending = null; s.debts = []; s.trade = null;
    log(ctx, `🏆 ${who(s.players[winnerId])} remporte la partie !`, 'important');
    emit(ctx, { t: 'end', winner: winnerId });
  }

  // Faillite : les biens vont au créancier (joueur) ou retournent à la banque.
  function goBankrupt(ctx, p) {
    const s = ctx.s;
    const debt = s.debts.find(d => d.from === p.id);
    const creditor = debt && debt.to !== null && !s.players[debt.to].bankrupt ? s.players[debt.to] : null;
    // 1. Les alertes sont revendues à la banque à moitié prix.
    p.properties.forEach(pos => {
      const lv = level(s, pos);
      if (lv > 0) { bankPays(ctx, p, Math.floor(cell(s, pos).buildCost / 2) * lv); delete s.buildings[pos]; }
    });
    // 2. Argent, titres et cartes « sortie de prison ».
    if (creditor) {
      creditor.money += p.money;
      creditor.properties.push(...p.properties);
      creditor.getOut.push(...p.getOut);
      log(ctx, `🏳️ ${who(p)} fait faillite : tout son argent (${p.money}) et ses biens passent à ${who(creditor)}.`, 'loss');
    } else {
      s.bankNet -= p.money;
      s.mortgaged = s.mortgaged.filter(pos => !p.properties.includes(pos));
      p.getOut.forEach(g => releaseGetOut(s, g));
      log(ctx, `🏳️ ${who(p)} fait faillite : ses biens retournent à la banque.`, 'loss');
    }
    p.money = 0; p.properties = []; p.getOut = []; p.bankrupt = true; p.inJail = false;
    emit(ctx, { t: 'bankrupt', player: p.id });
    // 3. Tout ce qui le concernait est annulé.
    s.debts = s.debts.filter(d => d.from !== p.id && d.to !== p.id);
    if (s.trade && (s.trade.from === p.id || s.trade.to === p.id)) s.trade = null;
    const pd = s.pending;
    if (pd && pd.type === 'auction') {
      if (pd.highBidder === p.id) { pd.highBidder = null; pd.highBid = 0; }
      pd.participants = pd.participants.filter(id => id !== p.id);
      closeAuctionIfDone(ctx);
    } else if (pd && pd.player === p.id) s.pending = null;
    // 4. Fin de partie, ou passage au joueur suivant si c'était son tour.
    const rest = alive(s);
    if (rest.length <= 1) { endGame(ctx, rest.length ? rest[0].id : p.id, 'last_standing'); return; }
    if (s.current === p.id) { s.pending = null; nextPlayer(ctx); }
  }

  // ── Enchères ─────────────────────────────────────────────────────────────
  function startAuction(ctx, pos) {
    const s = ctx.s;
    s.pending = { type: 'auction', pos, highBid: 0, highBidder: null, passed: [], participants: alive(s).map(p => p.id) };
    log(ctx, `🔨 ${cell(s, pos).name} est mise aux enchères !`, 'important');
    emit(ctx, { t: 'auction', pos });
  }
  function closeAuctionIfDone(ctx) {
    const s = ctx.s, pd = s.pending;
    if (!pd || pd.type !== 'auction') return;
    const active = pd.participants.filter(id => !pd.passed.includes(id));
    const c = cell(s, pd.pos);
    if (pd.highBidder !== null && active.length === 1 && active[0] === pd.highBidder) {
      const w = s.players[pd.highBidder];
      w.money -= pd.highBid; s.bankNet -= pd.highBid;
      w.properties.push(pd.pos);
      log(ctx, `🔨 Adjugé ! ${who(w)} remporte ${c.name} pour ${pd.highBid} ${CURRENCY}.`, 'gain');
      s.pending = null;
    } else if (active.length === 0 || (pd.highBidder === null && active.length === 0)) {
      log(ctx, `🔨 Personne n'a enchéri : ${c.name} reste à la banque.`);
      s.pending = null;
    }
  }

  // ── Échanges ─────────────────────────────────────────────────────────────
  function normSide(x) {
    x = x || {};
    const props = Array.isArray(x.props) ? [...new Set(x.props.map(Number))] : [];
    return { money: Number(x.money) || 0, props, getOut: Number(x.getOut) || 0 };
  }
  function checkSide(s, pid, side) {
    const p = s.players[pid];
    if (!isInt(side.money) || side.money < 0) return 'Montant invalide.';
    if (side.money > p.money) return `${p.name} n'a pas assez d'argent pour cet échange.`;
    if (!isInt(side.getOut) || side.getOut < 0 || side.getOut > p.getOut.length) return 'Nombre de cartes « sortie de prison » invalide.';
    for (const pos of side.props) {
      if (!isInt(pos) || !p.properties.includes(pos)) return `${p.name} ne possède pas ${s.board[pos] ? s.board[pos].name : 'cette case'}.`;
      const c = cell(s, pos);
      if (c.type === 'property' && groupHasBuildings(s, c.group)) return `${c.name} : vendez d'abord les alertes du groupe.`;
    }
    return null;
  }
  function validateTrade(s, t) {
    if (!s.players[t.to] || s.players[t.to].bankrupt || t.to === t.from) return 'Destinataire invalide.';
    if (s.players[t.from].bankrupt) return 'Joueur en faillite.';
    const empty = x => !x.money && !x.props.length && !x.getOut;
    if (empty(t.give) && empty(t.get)) return 'Échange vide.';
    return checkSide(s, t.from, t.give) || checkSide(s, t.to, t.get);
  }
  function describeSide(s, x) {
    const parts = [];
    if (x.money) parts.push(`${x.money} ${CURRENCY}`);
    x.props.forEach(pos => parts.push(cell(s, pos).name));
    if (x.getOut) parts.push(`${x.getOut} carte(s) sortie de prison`);
    return parts.length ? parts.join(', ') : 'rien';
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  // Chaque gestionnaire renvoie un message d'erreur (refus) ou rien (succès).
  const ACTIONS = {
    roll(ctx, pid) {
      const s = ctx.s, p = s.players[s.current];
      if (pid !== s.current) return "Ce n'est pas votre tour.";
      if (s.phase !== 'roll' || s.pending || s.debts.length) return 'Vous ne pouvez pas lancer les dés maintenant.';
      const d = ctx.opts.dice || [1 + Math.floor(rand(ctx) * 6), 1 + Math.floor(rand(ctx) * 6)];
      const total = d[0] + d[1], doubles = d[0] === d[1];
      s.dice = [d[0], d[1]];
      emit(ctx, { t: 'dice', player: p.id, d: s.dice });
      log(ctx, `${who(p)} lance : ${d[0]} + ${d[1]} = ${total}${doubles ? ' (doubles !)' : ''}`, 'move');
      s.phase = 'action';
      if (p.inJail) {
        if (doubles) {
          p.inJail = false; p.jailTurns = 0; s.noReroll = true;
          log(ctx, `${who(p)} sort grâce aux doubles !`, 'gain');
        } else {
          p.jailTurns++;
          if (p.jailTurns >= 3) {
            p.inJail = false; p.jailTurns = 0;
            log(ctx, `${who(p)} sort après 3 tours et doit payer la caution.`);
            pay(ctx, p, null, JAIL_FINE, 'caution');
          } else {
            log(ctx, `${who(p)} reste enfermé (tour ${p.jailTurns}/3).`);
            return;
          }
        }
      } else if (doubles) {
        s.doublesCount++;
        if (s.doublesCount >= 3) { log(ctx, `${who(p)} fait 3 doubles d'affilée !`, 'loss'); goToJail(ctx, p); return; }
      } else s.doublesCount = 0;
      walk(ctx, p, total);
    },

    pay_jail(ctx, pid) {
      const s = ctx.s, p = s.players[pid];
      if (pid !== s.current || s.phase !== 'roll' || s.pending || s.debts.length) return "Ce n'est pas le moment.";
      if (!p.inJail) return "Vous n'êtes pas enfermé.";
      if (p.money < JAIL_FINE) return 'Fonds insuffisants.';
      p.money -= JAIL_FINE; s.bankNet -= JAIL_FINE;
      p.inJail = false; p.jailTurns = 0;
      log(ctx, `${who(p)} paye ${JAIL_FINE} ${CURRENCY} de caution et sort.`, 'loss');
    },

    use_get_out(ctx, pid) {
      const s = ctx.s, p = s.players[pid];
      if (pid !== s.current || s.phase !== 'roll' || s.pending || s.debts.length) return "Ce n'est pas le moment.";
      if (!p.inJail) return "Vous n'êtes pas enfermé.";
      if (!p.getOut.length) return "Vous n'avez pas de carte « sortie de prison ».";
      releaseGetOut(s, p.getOut.pop());
      p.inJail = false; p.jailTurns = 0;
      log(ctx, `${who(p)} utilise sa carte « sortie de prison ».`, 'gain');
    },

    buy(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'buy' || pd.player !== pid) return 'Rien à acheter.';
      if (s.debts.length) return "Réglez d'abord la dette en cours.";
      const p = s.players[pid], c = cell(s, pd.pos);
      if (p.money < c.price) return 'Fonds insuffisants.';
      p.money -= c.price; s.bankNet -= c.price;
      p.properties.push(c.pos);
      s.pending = null;
      log(ctx, `${who(p)} achète ${c.name} pour ${c.price} ${CURRENCY}`, 'gain');
    },

    decline(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'buy' || pd.player !== pid) return 'Rien à refuser.';
      if (s.debts.length) return "Réglez d'abord la dette en cours.";
      const c = cell(s, pd.pos);
      log(ctx, `${who(s.players[pid])} ne prend pas ${c.name}.`);
      s.pending = null;
      if (s.config.auctions) startAuction(ctx, c.pos);
    },

    bid(ctx, pid, a) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'auction') return "Pas d'enchère en cours.";
      if (!pd.participants.includes(pid) || pd.passed.includes(pid)) return "Vous ne participez plus à cette enchère.";
      const amount = Number(a.amount);
      if (!isInt(amount) || amount <= pd.highBid) return `L'offre doit dépasser ${pd.highBid}.`;
      if (amount > s.players[pid].money) return 'Vous ne pouvez pas enchérir plus que votre argent.';
      pd.highBid = amount; pd.highBidder = pid;
      log(ctx, `🔨 ${who(s.players[pid])} offre ${amount} ${CURRENCY}`, 'chance');
      closeAuctionIfDone(ctx);
    },

    pass(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'auction') return "Pas d'enchère en cours.";
      if (!pd.participants.includes(pid) || pd.passed.includes(pid)) return 'Vous avez déjà passé.';
      if (pd.highBidder === pid) return "Vous êtes le meilleur enchérisseur : attendez les autres.";
      pd.passed.push(pid);
      log(ctx, `${who(s.players[pid])} passe.`);
      closeAuctionIfDone(ctx);
    },

    // Action « système » (serveur) : le délai de l'enchère est écoulé.
    auction_timeout(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (pid !== 'system') return 'Action réservée au serveur.';
      if (!pd || pd.type !== 'auction') return "Pas d'enchère en cours.";
      pd.participants.forEach(id => { if (id !== pd.highBidder && !pd.passed.includes(id)) pd.passed.push(id); });
      log(ctx, '⏱️ Temps écoulé pour l\'enchère.');
      closeAuctionIfDone(ctx);
      if (s.pending && s.pending.type === 'auction') { s.pending = null; log(ctx, 'Enchère annulée.'); }
    },

    choose_pay(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'card_choice' || pd.player !== pid) return 'Aucun choix en attente.';
      s.pending = null;
      pay(ctx, s.players[pid], null, pd.amount, 'amende');
    },

    choose_draw(ctx, pid) {
      const s = ctx.s, pd = s.pending;
      if (!pd || pd.type !== 'card_choice' || pd.player !== pid) return 'Aucun choix en attente.';
      s.pending = null;
      log(ctx, `${who(s.players[pid])} préfère tirer une carte Chance.`, 'chance');
      drawCard(ctx, s.players[pid], 'chance');
    },

    build(ctx, pid, a) {
      const err = canBuild(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos);
      p.money -= c.buildCost; s.bankNet -= c.buildCost;
      s.buildings[a.pos] = { houses: bld(s, a.pos).houses + 1, hotel: 0 };
      log(ctx, `${who(p)} achète une alerte sur ${c.name}`, 'gain');
    },

    upgrade(ctx, pid, a) {
      const err = canUpgrade(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos);
      p.money -= c.buildCost; s.bankNet -= c.buildCost;
      s.buildings[a.pos] = { houses: 0, hotel: 1 };
      log(ctx, `${who(p)} convertit ses 4 alertes en alerteprison sur ${c.name}`, 'gain');
    },

    sell_house(ctx, pid, a) {
      const err = canSellHouse(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos), b = bld(s, a.pos);
      const refund = Math.floor(c.buildCost / 2);
      if (b.houses - 1 > 0) s.buildings[a.pos] = { houses: b.houses - 1, hotel: 0 }; else delete s.buildings[a.pos];
      p.money += refund; s.bankNet += refund;
      log(ctx, `${who(p)} revend une alerte sur ${c.name} (+${refund})`, 'gain');
    },

    sell_hotel(ctx, pid, a) {
      const err = canSellHotel(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos);
      const half = Math.floor(c.buildCost / 2);
      // Normalement l'alerteprison redevient 4 alertes. En cas de pénurie, on
      // ne récupère que les alertes encore en stock et le reste est revendu
      // (règle officielle : c'est le seul cas où le groupe peut être inégal).
      const keep = Math.min(4, housesLeft(s));
      if (keep > 0) s.buildings[a.pos] = { houses: keep, hotel: 0 }; else delete s.buildings[a.pos];
      const refund = half * (5 - keep);
      p.money += refund; s.bankNet += refund;
      log(ctx, keep === 4
        ? `${who(p)} revend l'alerteprison de ${c.name}, qui redevient 4 alertes (+${refund})`
        : `${who(p)} revend l'alerteprison de ${c.name} (pénurie : ${keep} alerte(s) gardée(s)) (+${refund})`, 'gain');
    },

    mortgage(ctx, pid, a) {
      const err = canMortgage(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos);
      s.mortgaged.push(a.pos);
      p.money += c.mortgage; s.bankNet += c.mortgage;
      log(ctx, `${who(p)} hypothèque ${c.name} (+${c.mortgage})`, 'gain');
    },

    unmortgage(ctx, pid, a) {
      const err = canUnmortgage(ctx.s, pid, a.pos); if (err) return err;
      const s = ctx.s, p = s.players[pid], c = cell(s, a.pos), cost = unmortgageCost(c);
      s.mortgaged = s.mortgaged.filter(x => x !== a.pos);
      p.money -= cost; s.bankNet -= cost;
      log(ctx, `${who(p)} lève l'hypothèque de ${c.name} (-${cost})`, 'loss');
    },

    end_turn(ctx, pid) {
      const s = ctx.s, p = s.players[s.current];
      if (pid !== s.current) return "Ce n'est pas votre tour.";
      if (s.phase !== 'action') return "Lancez d'abord les dés.";
      if (s.debts.length) return "Une dette doit d'abord être réglée.";
      if (s.pending) return 'Une décision est en attente.';
      if (s.dice && s.dice[0] === s.dice[1] && !s.noReroll && !p.inJail) {
        s.phase = 'roll'; s.dice = null;
        log(ctx, `${who(p)} a fait un double : il rejoue !`, 'chance');
        return;
      }
      nextPlayer(ctx);
    },

    // Faillite déclarée par un joueur qui ne peut pas payer sa dette.
    bankrupt(ctx, pid) {
      const s = ctx.s;
      if (!hasDebt(s, pid)) return "Vous n'avez pas de dette : utilisez « Abandonner » pour quitter.";
      goBankrupt(ctx, s.players[pid]);
    },

    // Abandon volontaire (ou joueur retiré par l'hôte : pid = 'system', a.player).
    resign(ctx, pid, a) {
      const s = ctx.s;
      const target = pid === 'system' ? Number(a.player) : pid;
      const p = s.players[target];
      if (!p || p.bankrupt) return 'Joueur introuvable.';
      log(ctx, `${who(p)} ${pid === 'system' ? 'est retiré de la partie' : 'abandonne la partie'}.`, 'system');
      goBankrupt(ctx, p);
    },

    trade_propose(ctx, pid, a) {
      const s = ctx.s;
      if (s.trade) return 'Un échange est déjà en cours.';
      if (s.pending && s.pending.type === 'auction') return 'Attendez la fin de l\'enchère.';
      const t = { from: pid, to: Number(a.to), give: normSide(a.give), get: normSide(a.get) };
      const err = validateTrade(s, t); if (err) return err;
      s.trade = t;
      log(ctx, `🔁 ${who(s.players[pid])} propose à ${who(s.players[t.to])} : ${describeSide(s, t.give)} contre ${describeSide(s, t.get)}.`, 'chance');
      emit(ctx, { t: 'trade', from: pid, to: t.to });
    },

    trade_accept(ctx, pid) {
      const s = ctx.s, t = s.trade;
      if (!t || t.to !== pid) return "Aucun échange ne vous est proposé.";
      const err = validateTrade(s, t);
      if (err) { s.trade = null; log(ctx, `🔁 Échange annulé : ${err}`); return; }
      const A = s.players[t.from], B = s.players[t.to];
      A.money += t.get.money - t.give.money;
      B.money += t.give.money - t.get.money;
      t.give.props.forEach(pos => { A.properties.splice(A.properties.indexOf(pos), 1); B.properties.push(pos); });
      t.get.props.forEach(pos => { B.properties.splice(B.properties.indexOf(pos), 1); A.properties.push(pos); });
      for (let i = 0; i < t.give.getOut; i++) B.getOut.push(A.getOut.pop());
      for (let i = 0; i < t.get.getOut; i++) A.getOut.push(B.getOut.pop());
      s.trade = null;
      log(ctx, `🤝 Échange conclu entre ${who(A)} et ${who(B)} !`, 'gain');
    },

    trade_reject(ctx, pid) {
      const s = ctx.s;
      if (!s.trade || s.trade.to !== pid) return "Aucun échange ne vous est proposé.";
      log(ctx, `🔁 ${who(s.players[pid])} refuse l'échange.`);
      s.trade = null;
    },

    trade_cancel(ctx, pid) {
      const s = ctx.s;
      if (!s.trade || s.trade.from !== pid) return "Vous n'avez pas d'échange en cours.";
      log(ctx, `🔁 ${who(s.players[pid])} retire sa proposition d'échange.`);
      s.trade = null;
    },

    // Fin anticipée (hôte) : le plus gros patrimoine gagne.
    end_by_worth(ctx, pid) {
      const s = ctx.s;
      if (pid !== 'system') return 'Action réservée à l\'hôte.';
      const ranking = alive(s).map(p => ({ id: p.id, w: netWorth(s, p.id) })).sort((x, y) => y.w - x.w);
      log(ctx, '⏹️ Partie arrêtée : victoire au patrimoine.', 'system');
      ranking.forEach((r, i) => log(ctx, `${i + 1}. ${who(s.players[r.id])} — ${r.w} ${CURRENCY}`, 'system'));
      endGame(ctx, ranking[0].id, 'net_worth');
    },
  };

  // ── Vérifications de gestion (réutilisées par l'interface pour griser) ──
  function mgmtBase(s, pid, pos) {
    if (manager(s) !== pid) return "Vous ne pouvez pas gérer vos biens maintenant.";
    const c = cell(s, pos);
    if (!c || !s.players[pid].properties.includes(pos)) return "Ce bien n'est pas à vous.";
    return null;
  }
  function canBuild(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    const c = cell(s, pos), p = s.players[pid], b = bld(s, pos);
    if (c.type !== 'property') return 'On ne pose des alertes que sur des terrains.';
    if (!ownsGroup(s, pid, c.group)) return 'Il faut posséder tout le groupe de couleur.';
    if (groupCells(s, c.group).some(g => isMortgaged(s, g.pos))) return 'Un terrain du groupe est hypothéqué.';
    if (b.hotel || b.houses >= 4) return 'Maximum atteint : convertissez en alerteprison.';
    if (s.config.evenBuild && groupCells(s, c.group).some(g => g.pos !== pos && level(s, g.pos) < b.houses)) return 'Construction homogène : équipez d\'abord les autres terrains du groupe.';
    if (housesLeft(s) <= 0) return 'Plus aucune alerte en stock (pénurie).';
    if (p.money < c.buildCost) return 'Fonds insuffisants.';
    return null;
  }
  function canUpgrade(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    const c = cell(s, pos), p = s.players[pid], b = bld(s, pos);
    if (c.type !== 'property' || b.hotel || b.houses < 4) return 'Il faut 4 alertes pour convertir.';
    if (s.config.evenBuild && groupCells(s, c.group).some(g => level(s, g.pos) < 4)) return 'Construction homogène : 4 alertes partout dans le groupe d\'abord.';
    if (hotelsLeft(s) <= 0) return 'Plus aucune alerteprison en stock (pénurie).';
    if (p.money < c.buildCost) return 'Fonds insuffisants.';
    return null;
  }
  function canSellHouse(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    const c = cell(s, pos), b = bld(s, pos);
    if (b.hotel || b.houses <= 0) return 'Aucune alerte à revendre ici.';
    if (s.config.evenBuild && groupCells(s, c.group).some(g => level(s, g.pos) > b.houses)) return 'Vente homogène : revendez d\'abord sur les terrains les plus équipés.';
    return null;
  }
  function canSellHotel(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    return bld(s, pos).hotel ? null : "Pas d'alerteprison ici.";
  }
  function canMortgage(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    const c = cell(s, pos);
    if (isMortgaged(s, pos)) return 'Déjà hypothéquée.';
    if (c.type === 'property' && groupHasBuildings(s, c.group)) return 'Revendez d\'abord les alertes du groupe.';
    return null;
  }
  function canUnmortgage(s, pid, pos) {
    const e = mgmtBase(s, pid, pos); if (e) return e;
    if (!isMortgaged(s, pos)) return "Ce bien n'est pas hypothéqué.";
    if (s.players[pid].money < unmortgageCost(cell(s, pos))) return 'Fonds insuffisants.';
    return null;
  }

  // ── Point d'entrée ───────────────────────────────────────────────────────
  // apply(state, acteur, action[, opts]) → {ok, state, events} | {ok:false, error}
  //   acteur : id du joueur (0..5) ou 'system' (serveur / hôte).
  //   opts   : réservé aux tests ({dice:[a,b]} ou {rng}) — le serveur n'en passe jamais.
  function apply(state, actor, action, opts) {
    if (!state || !action || typeof action.type !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action.type)) {
      return { ok: false, error: 'Action inconnue.' };
    }
    if (state.phase === 'ended') return { ok: false, error: 'La partie est terminée.' };
    if (actor !== 'system') {
      const p = state.players[actor];
      if (!p) return { ok: false, error: 'Joueur inconnu.' };
      if (p.bankrupt) return { ok: false, error: 'Vous êtes en faillite.' };
    }
    const s = cloneState(state);
    const ctx = { s, events: [], opts: opts || {} };
    let err;
    try {
      const a = Object.assign({}, action);
      if ('pos' in a) a.pos = Number(a.pos);
      err = ACTIONS[action.type](ctx, actor, a);
    } catch (e) {
      return { ok: false, error: 'Erreur interne du moteur : ' + (e && e.message) };
    }
    if (err) return { ok: false, error: err };
    settleDebts(ctx);
    const rest = alive(s);
    if (s.phase !== 'ended' && rest.length <= 1 && rest.length) endGame(ctx, rest[0].id, 'last_standing');
    s.seq++;
    return { ok: true, state: s, events: ctx.events };
  }

  // Le coup vaut-il la peine d'être proposé ? (utilisé pour griser des boutons)
  function can(state, actor, action) { return apply(state, actor, action).ok; }

  // Action par défaut, PRUDENTE, pour un joueur absent ou dont le temps est écoulé :
  // lancer, refuser l'achat, passer aux enchères, refuser les échanges, finir le tour.
  // En cas de dette : revend des alertes, puis hypothèque les biens les moins chers,
  // et ne fait faillite que s'il ne reste vraiment plus rien.
  function autoAction(s, pid) {
    if (s.phase === 'ended' || !s.players[pid] || s.players[pid].bankrupt) return null;
    const p = s.players[pid];
    if (s.debts.length && s.debts[0].from === pid) {
      const props = p.properties.slice();
      const hotel = props.find(pos => canSellHotel(s, pid, pos) === null);
      if (hotel !== undefined) return { type: 'sell_hotel', pos: hotel };
      const house = props.filter(pos => canSellHouse(s, pid, pos) === null)
        .sort((a, b) => level(s, b) - level(s, a))[0];
      if (house !== undefined) return { type: 'sell_house', pos: house };
      const mort = props.filter(pos => canMortgage(s, pid, pos) === null)
        .sort((a, b) => cell(s, a).mortgage - cell(s, b).mortgage)[0];
      if (mort !== undefined) return { type: 'mortgage', pos: mort };
      return { type: 'bankrupt' };
    }
    if (s.debts.length) return null;
    const pd = s.pending;
    if (pd && pd.type === 'auction') {
      return awaiting(s).includes(pid) ? { type: 'pass' } : null;
    }
    if (pd && pd.player === pid) {
      if (pd.type === 'buy') return { type: 'decline' };
      if (pd.type === 'card_choice') return p.money >= pd.amount ? { type: 'choose_pay' } : { type: 'choose_draw' };
    }
    if (pd) return null;
    if (s.current !== pid) return null;
    if (s.phase === 'roll') return { type: 'roll' };
    if (s.phase === 'action') return { type: 'end_turn' };
    return null;
  }

  // Toutes les actions possibles d'un joueur (hors propositions d'échange) :
  // sert aux robots de test et aux vérifications.
  function legalActions(s, pid) {
    const cands = [{ type: 'roll' }, { type: 'pay_jail' }, { type: 'use_get_out' }, { type: 'buy' }, { type: 'decline' },
      { type: 'choose_pay' }, { type: 'choose_draw' }, { type: 'pass' }, { type: 'end_turn' }, { type: 'bankrupt' },
      { type: 'trade_accept' }, { type: 'trade_reject' }, { type: 'trade_cancel' }];
    const pd = s.pending;
    if (pd && pd.type === 'auction') {
      const m = s.players[pid] ? s.players[pid].money : 0;
      [pd.highBid + 1, pd.highBid + 10, pd.highBid + 50].forEach(v => { if (v <= m) cands.push({ type: 'bid', amount: v }); });
    }
    const out = cands.filter(a => can(s, pid, a));
    // Gestion des biens : vérifications directes (sans simuler), bien plus rapide.
    const p = s.players[pid];
    const checks = { build: canBuild, upgrade: canUpgrade, sell_house: canSellHouse, sell_hotel: canSellHotel, mortgage: canMortgage, unmortgage: canUnmortgage };
    if (p && !p.bankrupt && manager(s) === pid) {
      p.properties.forEach(pos => { for (const t in checks) if (checks[t](s, pid, pos) === null) out.push({ type: t, pos }); });
    }
    return out;
  }

  // Vue envoyée aux joueurs en ligne : sans la graine ni l'ordre des paquets.
  function publicView(s) {
    const { secret, ...rest } = s;
    return rest;
  }

  return {
    SCHEMA, GO_SALARY, JAIL_FINE, CURRENCY, BUYABLE, DEFAULT_CONFIG,
    createGame, apply, can, autoAction, legalActions, awaiting, manager, publicView, validateBoard, normalizeCards,
    rentFor, netWorth, ownerOf, ownsGroup, level, bld, isMortgaged, unmortgageCost, groupCells, housesLeft, hotelsLeft,
    canBuild, canUpgrade, canSellHouse, canSellHotel, canMortgage, canUnmortgage, isImagePawn, pawnChar, pathFor,
  };
});
