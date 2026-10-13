// Tests ciblés des règles.  Lancer :  node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, BOARD, cartes, card, game, act, refused, setup, checkInvariants } = require('./helpers.js');

const ok = s => assert.deepEqual(checkInvariants(s), []);
const at = (s, pid, pos) => setup(s, c => { c.players[pid].pos = pos; });
const own = (s, pid, ...pos) => setup(s, c => { c.players[pid].properties.push(...pos); });

test('passer par Départ rapporte 200, une seule fois', () => {
  let s = at(game(), 0, 38);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 3] });   // 38 → 2
  assert.equal(s.players[0].pos, 2);
  assert.equal(s.players[0].money, 1500 + 200);
  ok(s);
});

test('atterrir PILE sur Départ rapporte 200, pas 400', () => {
  let s = at(game(), 0, 35);
  s = act(s, 0, { type: 'roll' }, { dice: [2, 3] });
  assert.equal(s.players[0].pos, 0);
  assert.equal(s.players[0].money, 1700);
  ok(s);
});

test('grille de loyers : nu, groupe complet, 1-4 alertes, alerteprison', () => {
  let s = own(game(), 1, 1);
  const r = BOARD[1].rents;
  assert.equal(E.rentFor(s, 1), r[0]);
  s = own(s, 1, 3);
  assert.equal(E.rentFor(s, 1), r[0] * 2);
  for (let h = 1; h <= 4; h++) { s = setup(s, c => { c.buildings[1] = { houses: h, hotel: 0 }; }); assert.equal(E.rentFor(s, 1), r[h]); }
  s = setup(s, c => { c.buildings[1] = { houses: 0, hotel: 1 }; });
  assert.equal(E.rentFor(s, 1), r[5]);
  s = setup(s, c => { delete c.buildings[1]; c.mortgaged.push(1); });
  assert.equal(E.rentFor(s, 1), 0);
});

test('loyer payé au propriétaire en tombant sur son terrain', () => {
  let s = own(game(), 1, 1, 3);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });   // 0 → 3
  const rent = BOARD[3].rents[0] * 2;
  assert.equal(s.players[0].money, 1500 - rent);
  assert.equal(s.players[1].money, 1500 + rent);
  ok(s);
});

test('gares et compagnies', () => {
  let s = own(game(), 1, 5, 15, 25);
  assert.equal(E.rentFor(s, 5), BOARD[5].rents[2]);
  s = own(s, 1, 12);
  assert.equal(E.rentFor(s, 12, 7), 28);
  s = own(s, 1, 28);
  assert.equal(E.rentFor(s, 12, 7), 70);
});

test('3 doubles d\'affilée : prison, pas de relance', () => {
  let s = game();
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });   // → 2
  s = act(s, 0, { type: 'end_turn' });
  assert.equal(s.phase, 'roll'); assert.equal(s.current, 0);
  s = act(s, 0, { type: 'roll' }, { dice: [2, 2] });   // → 6 (à vendre)
  s = act(s, 0, { type: 'decline' });
  s = act(s, 1, { type: 'pass' }); s = act(s, 0, { type: 'pass' });
  s = act(s, 0, { type: 'end_turn' });
  s = act(s, 0, { type: 'roll' }, { dice: [3, 3] });
  assert.equal(s.players[0].pos, 10);
  assert.ok(s.players[0].inJail);
  s = act(s, 0, { type: 'end_turn' });
  assert.equal(s.current, 1);
  ok(s);
});

test('un double donne une relance, sauf en sortant de prison', () => {
  let s = game();
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });
  s = act(s, 0, { type: 'end_turn' });
  assert.equal(s.current, 0); assert.equal(s.phase, 'roll');

  s = setup(game(), c => { c.players[0].inJail = true; c.players[0].pos = 10; });
  s = act(s, 0, { type: 'roll' }, { dice: [3, 3] });   // sort, avance de 6 → 16
  assert.equal(s.players[0].inJail, false);
  assert.equal(s.players[0].pos, 16);
  s = act(s, 0, { type: 'decline' }); s = act(s, 0, { type: 'pass' }); s = act(s, 1, { type: 'pass' });
  s = act(s, 0, { type: 'end_turn' });
  assert.equal(s.current, 1);
});

test('prison : 3e échec → paye la caution et avance', () => {
  let s = setup(game(), c => { c.players[0].inJail = true; c.players[0].pos = 10; c.players[0].jailTurns = 2; });
  s = act(s, 0, { type: 'roll' }, { dice: [1, 3] });
  assert.equal(s.players[0].inJail, false);
  assert.equal(s.players[0].pos, 14);
  assert.equal(s.players[0].money, 1450);
  ok(s);
});

test('prison : payer la caution, utiliser une carte', () => {
  let s = setup(game(), c => { c.players[0].inJail = true; c.players[0].pos = 10; });
  assert.ok(refused(s, 0, { type: 'use_get_out' }));
  s = act(s, 0, { type: 'pay_jail' });
  assert.equal(s.players[0].money, 1450); assert.equal(s.players[0].inJail, false);
  ok(s);
});

test('achat, refus puis enchère', () => {
  let s = act(game(3), 0, { type: 'roll' }, { dice: [1, 2] });  // → 3
  assert.deepEqual(E.awaiting(s), [0]);
  assert.ok(refused(s, 0, { type: 'end_turn' }));
  s = act(s, 0, { type: 'decline' });
  assert.equal(s.pending.type, 'auction');
  assert.ok(refused(s, 1, { type: 'bid', amount: 0 }));
  s = act(s, 1, { type: 'bid', amount: 20 });
  s = act(s, 2, { type: 'bid', amount: 30 });
  assert.ok(refused(s, 2, { type: 'pass' }));             // meilleur enchérisseur
  s = act(s, 0, { type: 'pass' });
  s = act(s, 1, { type: 'pass' });
  assert.equal(s.pending, null);
  assert.deepEqual(s.players[2].properties, [3]);
  assert.equal(s.players[2].money, 1470);
  ok(s);
});

test('enchère sans offre : le bien reste à la banque ; délai écoulé', () => {
  let s = act(game(), 0, { type: 'roll' }, { dice: [1, 2] });
  s = act(s, 0, { type: 'decline' });
  s = act(s, 0, { type: 'pass' }); s = act(s, 1, { type: 'pass' });
  assert.equal(s.pending, null); assert.equal(E.ownerOf(s, 3), null);

  s = act(game(3), 0, { type: 'roll' }, { dice: [1, 2] });
  s = act(s, 0, { type: 'decline' });
  s = act(s, 1, { type: 'bid', amount: 5 });
  assert.ok(refused(s, 1, { type: 'auction_timeout' }));
  s = act(s, 'system', { type: 'auction_timeout' });
  assert.deepEqual(s.players[1].properties, [3]);
  ok(s);
});

test('sans enchères (option), refuser laisse simplement le bien', () => {
  let s = act(game(2, { config: { auctions: false } }), 0, { type: 'roll' }, { dice: [1, 2] });
  s = act(s, 0, { type: 'decline' });
  assert.equal(s.pending, null);
});

test('alertes : groupe complet, construction et vente homogènes', () => {
  let s = own(game(), 0, 6, 8);
  assert.ok(refused(s, 0, { type: 'build', pos: 6 }));       // groupe incomplet
  s = own(s, 0, 9);
  s = act(s, 0, { type: 'build', pos: 6 });
  assert.ok(refused(s, 0, { type: 'build', pos: 6 }));       // pas homogène
  s = act(s, 0, { type: 'build', pos: 8 });
  s = act(s, 0, { type: 'build', pos: 9 });
  s = act(s, 0, { type: 'build', pos: 6 });
  assert.ok(refused(s, 0, { type: 'sell_house', pos: 8 }));  // vendre d'abord le plus équipé
  s = act(s, 0, { type: 'sell_house', pos: 6 });
  assert.ok(refused(s, 0, { type: 'mortgage', pos: 9 }));    // alertes dans le groupe
  ok(s);
  for (let i = 0; i < 3; i++) for (const p of [6, 8, 9]) s = act(s, 0, { type: 'build', pos: p });
  assert.ok(refused(s, 0, { type: 'upgrade', pos: 9 }) === false);
  s = act(s, 0, { type: 'upgrade', pos: 9 });
  assert.equal(E.level(s, 9), 5);
  s = act(s, 0, { type: 'sell_hotel', pos: 9 });
  assert.equal(E.level(s, 9), 4);
  ok(s);
});

test('pas de construction si un terrain du groupe est hypothéqué', () => {
  let s = own(game(), 0, 1, 3);
  s = act(s, 0, { type: 'mortgage', pos: 3 });
  assert.ok(refused(s, 0, { type: 'build', pos: 1 }));
  s = act(s, 0, { type: 'unmortgage', pos: 3 });
  assert.equal(s.players[0].money, 1500 + 30 - 33);
  s = act(s, 0, { type: 'build', pos: 1 });
  ok(s);
});

test('pénurie : stock limité d\'alertes', () => {
  let s = own(game(2, { config: { buildingLimit: true } }), 0, 1, 3);
  s = setup(s, c => { c.config.houses = 1; c.players[0].money = 5000; });
  s = act(s, 0, { type: 'build', pos: 1 });
  assert.ok(refused(s, 0, { type: 'build', pos: 3 }));
});

test('dette : impossible de finir le tour, l\'hypothèque règle automatiquement', () => {
  let s = setup(own(game(), 0, 39), c => { c.players[0].money = 100; c.players[0].pos = 1; });
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });           // 1 → 4 : Discord Nitro, taxe 200
  assert.equal(s.debts.length, 1);
  assert.deepEqual(E.awaiting(s), [0]);
  assert.ok(refused(s, 0, { type: 'end_turn' }));
  s = act(s, 0, { type: 'mortgage', pos: 39 });              // +200 → 300, dette réglée
  assert.equal(s.debts.length, 0);
  assert.equal(s.players[0].money, 100);
  s = act(s, 0, { type: 'end_turn' });
  ok(s);
});

test('faillite envers un joueur : il récupère argent et biens', () => {
  let s = setup(game(3), c => {
    c.players[1].properties.push(37, 39); c.buildings[39] = { houses: 3, hotel: 0 }; c.buildings[37] = { houses: 3, hotel: 0 };
    c.players[0].money = 30; c.players[0].properties.push(12); c.mortgaged.push(12); c.players[0].pos = 35;
  });
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });           // → 37 : loyer énorme
  assert.equal(s.debts.length, 1);
  s = act(s, 0, { type: 'bankrupt' });
  assert.ok(s.players[0].bankrupt);
  assert.ok(s.players[1].properties.includes(12));
  assert.ok(E.isMortgaged(s, 12));
  assert.equal(s.current, 1);
  ok(s);
});

test('faillite envers la banque : les biens redeviennent libres', () => {
  let s = setup(game(3), c => { c.players[0].money = 50; c.players[0].properties.push(12); c.mortgaged.push(12); c.players[0].pos = 1; });
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });           // taxe 200
  s = act(s, 0, { type: 'bankrupt' });
  assert.equal(E.ownerOf(s, 12), null);
  assert.ok(!E.isMortgaged(s, 12));
  ok(s);
});

test('dernier joueur debout : fin de partie', () => {
  let s = act(game(2), 0, { type: 'resign' });
  assert.equal(s.phase, 'ended'); assert.equal(s.winner, 1);
  assert.ok(refused(s, 1, { type: 'roll' }));
});

test('fin au patrimoine (hôte)', () => {
  let s = own(game(3), 2, 39);
  assert.ok(refused(s, 0, { type: 'end_by_worth' }));
  s = act(s, 'system', { type: 'end_by_worth' });
  assert.equal(s.winner, 2);
});

test('carte move_to en arrière (Redoublement) : jamais de bonus Départ', () => {
  const c = card('move_to', { targetPos: 3, moveBackward: true });
  let s = at(game(2, { cards: { chance: [c], community: [] } }), 0, 33);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });           // 33 → 36 Chance → recule à 3
  assert.equal(s.players[0].pos, 3);
  assert.equal(s.players[0].money, 1500);
});

test('carte move_to en avant : bonus Départ si on passe par 0', () => {
  const c = card('move_to', { targetPos: 12 });
  let s = at(game(2, { cards: { chance: [c], community: [] } }), 0, 33);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });
  assert.equal(s.players[0].pos, 12);
  assert.equal(s.players[0].money, 1700);
  assert.equal(s.pending.type, 'buy');
});

test('carte goto_direct : téléportation sans bonus', () => {
  const c = card('goto_direct', { targetPos: 20 });
  let s = at(game(2, { cards: { chance: [c], community: [] } }), 0, 33);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 2] });
  assert.equal(s.players[0].pos, 20); assert.equal(s.players[0].money, 1500);
});

test('carte move_by -3 : recule sans bonus', () => {
  const c = card('move_by', { moveSteps: -3 });
  let s = at(game(2, { cards: { chance: [c], community: [] } }), 0, 0);
  s = act(s, 0, { type: 'roll' }, { dice: [3, 4] });           // 0 → 7 Chance → 4 (taxe)
  assert.equal(s.players[0].pos, 4);
  assert.equal(s.players[0].money, 1300);
});

test('carte sortie de prison : gardée, jamais retirée tant qu\'elle est en main', () => {
  const c = card('get_out'), g = card('gain', { amount: 10, id: 98 });
  let s = at(game(2, { cards: { chance: [c, g], community: [] } }), 0, 5);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });
  let draws = 0;
  // Tire encore plusieurs cartes : seule la carte « gain » doit sortir.
  for (let i = 0; i < 4; i++) {
    s = setup(s, x => { x.pending = null; x.phase = 'roll'; x.players[0].pos = 5; x.players[0].inJail = false; x.current = 0; x.doublesCount = 0; });
    s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });
    draws++;
  }
  assert.equal(s.players[0].getOut.length, 1);
  assert.equal(s.players[0].money, 1500 + 10 * draws);
  s = setup(s, x => { x.players[0].inJail = true; x.phase = 'roll'; x.dice = null; });
  s = act(s, 0, { type: 'use_get_out' });
  assert.equal(s.players[0].getOut.length, 0);
  ok(s);
});

test('carte anniversaire : un joueur trop pauvre doit une dette au tireur', () => {
  const c = card('birthday', { collectAmount: 50 });
  let s = setup(game(3, { cards: { chance: [c], community: [] } }), x => { x.players[2].money = 10; x.players[0].pos = 5; });
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });
  assert.equal(s.players[0].money, 1550);                     // J2 a payé, J3 doit
  assert.deepEqual(E.awaiting(s), [2]);
  assert.ok(refused(s, 0, { type: 'end_turn' }));
  s = act(s, 2, { type: 'bankrupt' });
  assert.equal(s.players[0].money, 1560);                     // ses 10 restants
  ok(s);
});

test('carte payer OU tirer Chance', () => {
  const choice = card('pay_or_chance', { deck: 'community', amount: 10 });
  const gain = card('gain', { amount: 100 });
  let s = at(game(2, { cards: { chance: [gain], community: [choice] } }), 0, 0);
  s = act(s, 0, { type: 'roll' }, { dice: [1, 1] });           // → 2 communauté
  assert.equal(s.pending.type, 'card_choice');
  const paid = act(s, 0, { type: 'choose_pay' });
  assert.equal(paid.players[0].money, 1490);
  const drew = act(s, 0, { type: 'choose_draw' });
  assert.equal(drew.players[0].money, 1600);
});

test('échanges : proposer, accepter, refuser, restrictions', () => {
  let s = own(own(game(3), 0, 1), 1, 3);
  s = act(s, 0, { type: 'trade_propose', to: 1, give: { money: 100, props: [1] }, get: { props: [3] } });
  assert.ok(refused(s, 2, { type: 'trade_accept' }));
  assert.ok(refused(s, 1, { type: 'trade_propose', to: 0, give: {}, get: { money: 1 } }));
  s = act(s, 1, { type: 'trade_accept' });
  assert.deepEqual(s.players[1].properties, [1]);
  assert.deepEqual(s.players[0].properties, [3]);
  assert.equal(s.players[0].money, 1400); assert.equal(s.players[1].money, 1600);
  ok(s);
  assert.ok(refused(s, 0, { type: 'trade_propose', to: 1, give: { props: [1] }, get: {} }));   // pas à lui
  assert.ok(refused(s, 0, { type: 'trade_propose', to: 1, give: { money: 99999 }, get: {} })); // trop cher
  s = act(s, 0, { type: 'trade_propose', to: 1, give: { money: 5 }, get: {} });
  s = act(s, 1, { type: 'trade_reject' });
  assert.equal(s.trade, null);
  s = own(s, 0, 1); s = setup(s, x => { x.players[1].properties = []; x.buildings[1] = { houses: 1, hotel: 0 }; x.buildings[3] = { houses: 1, hotel: 0 }; });
  assert.ok(refused(s, 0, { type: 'trade_propose', to: 1, give: { props: [1] }, get: {} })); // alertes dans le groupe
});

test('vue publique : ni graine ni ordre des paquets', () => {
  const s = game(2, { cards: cartes });
  const v = E.publicView(s);
  assert.equal(v.secret, undefined);
  assert.ok(!JSON.stringify(v).includes('"order"'));
});

test('déterministe : même graine + mêmes actions = même partie', () => {
  const run = () => {
    let s = game(3, { cards: cartes, seed: 42 });
    for (let i = 0; i < 300 && s.phase !== 'ended'; i++) {
      const pid = E.awaiting(s)[0];
      const a = E.autoAction(s, pid) || { type: 'end_turn' };
      const r = E.apply(s, pid, a);
      if (!r.ok) throw new Error(r.error);
      s = r.state;
    }
    return JSON.stringify(s);
  };
  assert.equal(run(), run());
});

test('actions invalides refusées proprement', () => {
  const s = game();
  assert.ok(refused(s, 1, { type: 'roll' }));
  assert.ok(refused(s, 0, { type: '__proto__' }));
  assert.ok(refused(s, 0, { type: 'constructor' }));
  assert.ok(refused(s, 0, { type: 'build', pos: 'abc' }));
  assert.ok(refused(s, 9, { type: 'roll' }));
  assert.ok(refused(s, 0, { type: 'bid', amount: 1e9 }));
  assert.ok(refused(s, 0, {}));
});
