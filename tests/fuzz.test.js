// Parties jouées au hasard par des robots, avec vérification des invariants
// après CHAQUE coup. C'est ce genre de test qui attrape tout seul les bugs du
// style « double bonus Départ » ou « alerte restée sur un terrain sans proprio ».
//   node --test "tests/*.test.js"      (FUZZ_GAMES=1500 pour une passe plus longue)
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, BOARD, cartes, checkInvariants } = require('./helpers.js');

// Générateur déterministe pour que tout échec soit reproductible.
function mulberry(seed) {
  return function () {
    let t = (seed = (seed + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHT = { buy: 8, build: 4, upgrade: 3, bid: 2, pass: 2, end_turn: 3, roll: 5, unmortgage: 2, bankrupt: 0.05,
  mortgage: 0.3, sell_house: 0.3, sell_hotel: 0.3, trade_accept: 1, trade_reject: 1, trade_cancel: 0.3 };

function pick(rng, list) {
  const tot = list.reduce((a, x) => a + (WEIGHT[x.type] ?? 1), 0);
  let r = rng() * tot;
  for (const x of list) { r -= WEIGHT[x.type] ?? 1; if (r <= 0) return x; }
  return list[list.length - 1];
}

function randomTrade(s, pid, rng) {
  const others = s.players.filter(p => !p.bankrupt && p.id !== pid);
  if (!others.length) return null;
  const o = others[Math.floor(rng() * others.length)];
  const me = s.players[pid];
  const sub = arr => arr.filter(() => rng() < 0.3);
  return { type: 'trade_propose', to: o.id,
    give: { money: rng() < 0.5 ? Math.floor(rng() * Math.min(me.money, 300)) : 0, props: sub(me.properties), getOut: rng() < 0.2 ? me.getOut.length : 0 },
    get: { money: rng() < 0.3 ? Math.floor(rng() * Math.min(o.money, 300)) : 0, props: sub(o.properties), getOut: 0 } };
}

function playGame(seed, maxSteps) {
  const rng = mulberry(seed);
  const n = 2 + Math.floor(rng() * 5);
  const config = { auctions: rng() < 0.7, evenBuild: rng() < 0.8, buildingLimit: rng() < 0.3, startMoney: rng() < 0.3 ? 500 : 1500 };
  let s = E.createGame({ board: BOARD, cards: cartes, players: [...Array(n).keys()].map(i => ({ name: 'Bot' + i, pawn: '🤖' })), config, seed });
  let steps = 0;
  for (; steps < maxSteps && s.phase !== 'ended'; steps++) {
    let pid, action;
    const r0 = rng();
    if (s.trade && r0 < 0.5) pid = s.trade.to;
    else pid = E.awaiting(s)[Math.floor(rng() * E.awaiting(s).length)];
    if (r0 > 0.97 && !s.trade) {
      const who = s.players.filter(p => !p.bankrupt);
      const tpid = who[Math.floor(rng() * who.length)].id;
      const t = randomTrade(s, tpid, rng);
      if (t && E.can(s, tpid, t)) { pid = tpid; action = t; }
    } else if (r0 < 0.0008) action = { type: 'resign' };
    if (!action || !E.can(s, pid, action)) {
      const legal = E.legalActions(s, pid);
      if (!legal.length) {
        // Aucun coup légal pour la personne attendue : c'est un blocage.
        const auto = E.autoAction(s, pid);
        throw new Error(`Blocage (graine ${seed}, coup ${steps}) : joueur ${pid} attendu sans action possible. auto=${JSON.stringify(auto)} pending=${JSON.stringify(s.pending)} debts=${JSON.stringify(s.debts)}`);
      }
      action = pick(rng, legal);
    }
    const r = E.apply(s, pid, action);
    if (!r.ok) throw new Error(`Graine ${seed}, coup ${steps} : action légale refusée ${JSON.stringify(action)} : ${r.error}`);
    s = r.state;
    const errs = checkInvariants(s);
    if (errs.length) throw new Error(`Graine ${seed}, coup ${steps}, après ${JSON.stringify(action)} par ${pid} :\n  ${errs.join('\n  ')}`);
  }
  return { ended: s.phase === 'ended', steps, turns: s.turn };
}

test('robots aléatoires : aucun invariant violé, aucun blocage', () => {
  const N = Number(process.env.FUZZ_GAMES || 60);
  let ended = 0, steps = 0;
  for (let g = 1; g <= N; g++) {
    const r = playGame(g * 7919, 2500);
    if (r.ended) ended++;
    steps += r.steps;
  }
  console.log(`  ${N} parties, ${steps} coups joués, ${ended} parties terminées jusqu'au bout.`);
  assert.ok(ended > 0);
});

test('robots « absents » (action automatique prudente) : jamais de blocage', () => {
  for (let g = 1; g <= 60; g++) {
    let s = E.createGame({ board: BOARD, cards: cartes, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: g });
    for (let i = 0; i < 1500 && s.phase !== 'ended'; i++) {
      const pid = E.awaiting(s)[0];
      const a = E.autoAction(s, pid);
      assert.ok(a, `graine ${g} coup ${i} : autoAction vide pour ${pid}`);
      const r = E.apply(s, pid, a);
      assert.ok(r.ok, `graine ${g} coup ${i} : ${JSON.stringify(a)} refusé : ${r.error}`);
      s = r.state;
      assert.deepEqual(checkInvariants(s), []);
    }
  }
});

test('mode auto en dette : revend puis hypothèque avant la faillite', () => {
  let s = E.createGame({ board: BOARD, cards: { chance: [], community: [] }, players: [{ name: 'A' }, { name: 'B' }], seed: 3 });
  const c = JSON.parse(JSON.stringify(Object.assign({}, s, { board: null, cards: null }))); c.board = s.board; c.cards = s.cards;
  c.players[0].properties.push(1, 3, 12); c.buildings[1] = { houses: 1, hotel: 0 }; c.buildings[3] = { houses: 2, hotel: 0 };
  c.players[1].properties.push(39); c.buildings[39] = { houses: 0, hotel: 1 }; c.players[1].properties.push(37); c.buildings[37] = { houses: 4, hotel: 0 };
  c.players[0].money = 0; c.bankNet -= 1500; c.players[0].pos = 35;
  s = E.apply(c, 0, { type: 'roll' }, { dice: [2, 2] }).state;    // → 39 : loyer 2000
  const seen = [];
  while (s.debts.length) {
    const a = E.autoAction(s, 0);
    seen.push(a.type);
    s = E.apply(s, 0, a).state;
  }
  assert.deepEqual(seen.slice(0, 3), ['sell_house', 'sell_house', 'sell_house']);
  assert.ok(seen.includes('mortgage'));
  assert.equal(seen[seen.length - 1], 'bankrupt');
  assert.deepEqual(checkInvariants(s), []);
});
