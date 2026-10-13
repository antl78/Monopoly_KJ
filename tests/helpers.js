// Outils communs aux tests du moteur.
const path = require('path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const plateau = require(path.join(ROOT, 'plateau.json'));
const cartes = require(path.join(ROOT, 'cartes.json'));
const BOARD = plateau.board;

function card(effect, extra) {
  return Object.assign({ id: 99, deck: 'chance', icon: '🃏', text: 'Carte test', flavor: '', effect,
    amount: 0, perHouse: 0, perHotel: 0, targetPos: 0, moveSteps: 0, collectAmount: 0 }, extra || {});
}

// Partie de test : vrai plateau, cartes au choix (vides par défaut pour que
// les cases Chance/Communauté n'aient aucun effet parasite).
function game(n, opts) {
  opts = opts || {};
  const players = [...Array(n || 2).keys()].map(i => ({ name: 'J' + (i + 1), pawn: ['🎩', '🚂', '🐕', '🚗', '⛵', '👢'][i] }));
  return E.createGame({ board: BOARD, cards: opts.cards || { chance: [], community: [] }, players, config: opts.config, seed: opts.seed || 1 });
}

// Applique une action et échoue bruyamment si elle est refusée.
function act(s, pid, action, opts) {
  const r = E.apply(s, pid, action, opts);
  if (!r.ok) throw new Error(`Action refusée ${JSON.stringify(action)} par ${pid} : ${r.error}`);
  return r.state;
}
function refused(s, pid, action, opts) { return !E.apply(s, pid, action, opts).ok; }

// Modifie l'état à la main pour préparer une situation.
// Si la préparation change l'argent des joueurs, on compense dans bankNet
// pour que l'invariant « l'argent est conservé » reste vrai.
function setup(s, fn) {
  const c = JSON.parse(JSON.stringify(Object.assign({}, s, { board: null, cards: null })));
  c.board = s.board; c.cards = s.cards;
  const before = c.players.reduce((a, p) => a + p.money, 0);
  fn(c);
  c.bankNet += c.players.reduce((a, p) => a + p.money, 0) - before;
  return c;
}

// Invariants qui doivent TOUJOURS tenir, quoi qu'il arrive.
function checkInvariants(s) {
  const errs = [];
  const n = s.players.length;
  const total = s.players.reduce((a, p) => a + p.money, 0);
  if (total !== s.config.startMoney * n + s.bankNet) errs.push(`argent non conservé : ${total} ≠ ${s.config.startMoney * n + s.bankNet}`);
  const seen = new Map();
  s.players.forEach(p => {
    if (!Number.isInteger(p.money)) errs.push(`argent non entier pour ${p.name}`);
    if (p.bankrupt && (p.properties.length || p.money || p.getOut.length)) errs.push(`${p.name} en faillite possède encore des choses`);
    if (!p.bankrupt && p.money < 0) errs.push(`${p.name} a de l'argent négatif (${p.money})`);
    p.properties.forEach(pos => {
      if (!E.BUYABLE.includes(s.board[pos].type)) errs.push(`${p.name} possède une case non achetable ${pos}`);
      if (seen.has(pos)) errs.push(`case ${pos} possédée deux fois`);
      seen.set(pos, p.id);
    });
  });
  for (const k in s.buildings) {
    const pos = Number(k), b = s.buildings[k], c = s.board[pos];
    if (c.type !== 'property') errs.push(`alertes sur une case non-terrain ${pos}`);
    if (!seen.has(pos)) errs.push(`alertes sur un terrain sans propriétaire ${pos}`);
    else if (!E.ownsGroup(s, seen.get(pos), c.group)) errs.push(`alertes sans groupe complet ${pos}`);
    if (b.hotel && b.houses) errs.push(`alertes + alerteprison ensemble ${pos}`);
    if (b.houses < 0 || b.houses > 4) errs.push(`nombre d'alertes invalide ${pos}`);
    if (!b.hotel && !b.houses) errs.push(`entrée vide dans buildings ${pos}`);
    if (s.mortgaged.includes(pos)) errs.push(`terrain hypothéqué avec alertes ${pos}`);
  }
  s.mortgaged.forEach(pos => { if (!seen.has(pos)) errs.push(`hypothèque sur un bien sans propriétaire ${pos}`); });
  if (new Set(s.mortgaged).size !== s.mortgaged.length) errs.push('hypothèque en double');
  // En pénurie, la règle officielle autorise un groupe inégal après la revente d'une alerteprison.
  if (s.config.evenBuild && !s.config.buildingLimit) {
    const groups = [...new Set(s.board.filter(c => c.type === 'property').map(c => c.group))];
    groups.forEach(g => {
      const lv = E.groupCells(s, g).map(c => E.level(s, c.pos));
      if (Math.max(...lv) - Math.min(...lv) > 1) errs.push(`construction non homogène dans ${g} : ${lv}`);
    });
  }
  if (s.config.buildingLimit) {
    if (E.housesLeft(s) < 0) errs.push('stock d\'alertes négatif');
    if (E.hotelsLeft(s) < 0) errs.push('stock d\'alerteprisons négatif');
  }
  if (s.pending && s.pending.type === 'buy' && E.ownerOf(s, s.pending.pos)) errs.push('achat proposé sur un bien déjà possédé');
  if (s.pending && s.pending.type === 'auction' && E.ownerOf(s, s.pending.pos)) errs.push('enchère sur un bien déjà possédé');
  ['chance', 'community'].forEach(deck => {
    const held = s.secret.decks[deck].held.length;
    const inHands = s.players.reduce((a, p) => a + p.getOut.filter(g => g.deck === deck).length, 0);
    if (held !== inHands) errs.push(`cartes sortie de prison ${deck} : ${held} tenues vs ${inHands} en main`);
  });
  if (s.phase !== 'ended') {
    if (s.players[s.current].bankrupt) errs.push('le joueur courant est en faillite');
    if (!E.awaiting(s).length) errs.push('personne n\'est attendu : blocage');
    s.debts.forEach(d => { if (s.players[d.from].bankrupt) errs.push('dette d\'un joueur en faillite'); });
  }
  if (s.phase === 'ended' && s.winner === null) errs.push('partie finie sans gagnant');
  return errs;
}

module.exports = { E, BOARD, cartes, card, game, act, refused, setup, checkInvariants };
