const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const clients = new Map();

function broadcast(roomId, msg, excludeId=null) {
  const room = rooms.get(roomId); if(!room) return;
  const payload = JSON.stringify(msg);
  for(const [wsId, info] of clients) {
    if(info.roomId===roomId && wsId!==excludeId && info.ws.readyState===1) info.ws.send(payload);
  }
}
function sendTo(wsId, msg) {
  const info = clients.get(wsId);
  if(info && info.ws.readyState===1) info.ws.send(JSON.stringify(msg));
}
function roomState(roomId) {
  const room = rooms.get(roomId); if(!room) return null;
  return { id:room.id, hostId:room.hostId, phase:room.phase, players:Object.fromEntries(room.players), gameState:room.gameState };
}

wss.on('connection', (ws) => {
  const wsId = randomUUID();
  clients.set(wsId, { ws, roomId:null });
  ws.on('message', (raw) => { try { handle(wsId, JSON.parse(raw)); } catch(e){ console.error(e); } });
  ws.on('close', () => {
    const info = clients.get(wsId);
    if(info && info.roomId) {
      const room = rooms.get(info.roomId);
      if(room) {
        room.players.delete(wsId);
        broadcast(info.roomId, { type:'player_left', wsId, players:Object.fromEntries(room.players) });
        if(room.players.size===0) { rooms.delete(info.roomId); console.log('Room '+info.roomId+' supprimee'); }
      }
    }
    clients.delete(wsId);
  });
  ws.send(JSON.stringify({ type:'hello', wsId }));
});

function handle(wsId, msg) {
  const ci = clients.get(wsId);
  switch(msg.type) {
    case 'create_room': {
      const roomId = Math.random().toString(36).slice(2,7).toUpperCase();
      const room = { id:roomId, hostId:wsId, phase:'lobby', players:new Map(), gameState:null, boardData:msg.boardData||null, cardData:msg.cardData||null };
      const player = { wsId, name:msg.playerName||'Hote', pawn:msg.pawn||'🎩', isHost:true };
      room.players.set(wsId, player);
      rooms.set(roomId, room);
      ci.roomId = roomId;
      sendTo(wsId, { type:'room_created', roomId, state:roomState(roomId) });
      console.log('Room creee: '+roomId+' par '+msg.playerName);
      break;
    }
    case 'join_room': {
      const room = rooms.get(msg.roomId);
      if(!room) { sendTo(wsId, { type:'error', message:'Salon introuvable.' }); return; }
      if(room.phase!=='lobby') { sendTo(wsId, { type:'error', message:'Partie en cours.' }); return; }
      if(room.players.size>=6) { sendTo(wsId, { type:'error', message:'Salon complet.' }); return; }
      const player = { wsId, name:msg.playerName||'Joueur', pawn:msg.pawn||'🚂', isHost:false };
      room.players.set(wsId, player);
      ci.roomId = msg.roomId;
      sendTo(wsId, { type:'room_joined', roomId:msg.roomId, state:roomState(msg.roomId) });
      broadcast(msg.roomId, { type:'player_joined', player, players:Object.fromEntries(room.players) }, wsId);
      console.log(msg.playerName+' rejoint '+msg.roomId);
      break;
    }
    case 'upload_data': {
      const room = rooms.get(ci.roomId);
      if(!room||room.hostId!==wsId) return;
      if(msg.boardData) room.boardData = msg.boardData;
      if(msg.cardData) room.cardData = msg.cardData;
      const upd = { type:'data_updated', hasBoardData:!!room.boardData, hasCardData:!!room.cardData };
      broadcast(ci.roomId, upd); sendTo(wsId, upd);
      break;
    }
    case 'start_game': {
      const room = rooms.get(ci.roomId);
      if(!room||room.hostId!==wsId) return;
      if(room.players.size<2) { sendTo(wsId, { type:'error', message:'2 joueurs minimum.' }); return; }
      room.phase = 'playing';
      const sm = msg.startMoney||1500;
      const plist = Array.from(room.players.values());
      const { defaultCards } = require('./public/defaultData.js');
      const cards = room.cardData||defaultCards();
      room.gameState = {
        players: plist.map((p,i)=>({ id:i, wsId:p.wsId, name:p.name, pawn:p.pawn, money:sm, pos:0, inJail:false, jailTurns:0, getOutCards:0, properties:[], bankrupt:false })),
        currentPlayer:0, turn:1, phase:'roll', doublesCount:0, diceRoll:null,
        propertyBuildings:{}, mortgaged:[],
        chanceIdx:0, communityIdx:0,
        chanceOrder:shuffle([...Array(cards.chance.length).keys()]),
        communityOrder:shuffle([...Array(cards.community.length).keys()]),
        pendingCard:null, log:[]
      };
      const payload = { type:'game_started', gameState:room.gameState, boardData:room.boardData, cardData:room.cardData };
      broadcast(ci.roomId, payload); sendTo(wsId, payload);
      console.log('Partie dans '+ci.roomId);
      break;
    }
    case 'game_action': {
      const room = rooms.get(ci.roomId);
      if(!room||room.phase!=='playing') return;
      const gs = room.gameState;
      const cp = gs.players[gs.currentPlayer];
      if(msg.action!=='card_confirm' && wsId!==cp?.wsId) { sendTo(wsId,{type:'error',message:"Pas votre tour."}); return; }
      const ok = processAction(room, wsId, msg.action, msg.data||{});
      if(ok) {
        const upd = { type:'state_update', gameState:gs };
        broadcast(ci.roomId, upd); sendTo(wsId, upd);
        const alive = gs.players.filter(p=>!p.bankrupt);
        if(alive.length===1 && room.phase==='playing') {
          room.phase='ended';
          const end = { type:'game_over', winner:alive[0] };
          broadcast(ci.roomId, end); sendTo(wsId, end);
        }
      }
      break;
    }
    case 'chat': {
      const room = rooms.get(ci.roomId); if(!room) return;
      const player = room.players.get(wsId);
      const chatMsg = { type:'chat', from:player?.name||'?', pawn:player?.pawn||'', text:msg.text };
      broadcast(ci.roomId, chatMsg); sendTo(wsId, chatMsg);
      break;
    }
  }
}

function processAction(room, wsId, action, data) {
  const gs = room.gameState;
  const { defaultBoard, defaultCards } = require('./public/defaultData.js');
  const board = room.boardData||defaultBoard();
  const cards = room.cardData||defaultCards();
  const p = gs.players[gs.currentPlayer];
  if(!p) return false;
  const log = (msg, type='') => { gs.log = gs.log.slice(-80); gs.log.push({msg,type,ts:Date.now()}); };

  switch(action) {
    case 'roll': {
      if(gs.phase!=='roll') return false;
      const d1=Math.ceil(Math.random()*6), d2=Math.ceil(Math.random()*6);
      const total=d1+d2, doubles=d1===d2;
      gs.diceRoll=[d1,d2];
      log(p.pawn+' '+p.name+' : '+d1+'+'+d2+'='+total+(doubles?' (doubles!)':''), 'move');
      if(p.inJail) {
        if(doubles){p.inJail=false;p.jailTurns=0;log(p.pawn+' sort de prison (doubles).','gain');}
        else{p.jailTurns++;if(p.jailTurns>=3){p.inJail=false;p.jailTurns=0;p.money-=50;log(p.pawn+' sort apres 3 tours, paye M$50.','loss');}else{log(p.pawn+' en prison tour '+p.jailTurns+'/3.');gs.phase='action';return true;}}
      }
      if(doubles){gs.doublesCount++;if(gs.doublesCount>=3){goToJail(p,gs,log);gs.phase='action';return true;}}
      else gs.doublesCount=0;
      movePlayer(p,total,board,gs,cards,log);
      return true;
    }
    case 'buy': {
      if(gs.phase!=='action') return false;
      const cell=board[p.pos];
      if(!cell||!['property','station','utility'].includes(cell.type)) return false;
      if(gs.players.some(pl=>pl.properties.includes(p.pos))) return false;
      if(p.money<cell.price) return false;
      p.money-=cell.price; p.properties.push(p.pos);
      log(p.pawn+' achete '+cell.name+' (M$'+cell.price+')','gain'); return true;
    }
    case 'build_house': {
      const pos=data.pos, cell=board[pos];
      if(!cell||!p.properties.includes(pos)) return false;
      if(!gs.propertyBuildings[pos]) gs.propertyBuildings[pos]={houses:0,hotel:0};
      const b=gs.propertyBuildings[pos];
      if(b.hotel||b.houses>=4||p.money<cell.buildCost) return false;
      p.money-=cell.buildCost; b.houses++;
      log(p.pawn+' achète une alerte sur '+cell.name,'gain'); return true;
    }
    case 'build_hotel': {
      const pos=data.pos, cell=board[pos];
      if(!cell||!p.properties.includes(pos)) return false;
      if(!gs.propertyBuildings[pos]) gs.propertyBuildings[pos]={houses:0,hotel:0};
      const b=gs.propertyBuildings[pos];
      if(b.hotel||b.houses<4||p.money<cell.buildCost) return false;
      p.money-=cell.buildCost; b.houses=0; b.hotel=1;
      log(p.pawn+' convertit ses 4 alertes en alerteprison sur '+cell.name,'gain'); return true;
    }
    case 'mortgage': {
      const pos=data.pos, cell=board[pos];
      if(!p.properties.includes(pos)||gs.mortgaged.includes(pos)) return false;
      gs.mortgaged.push(pos); p.money+=cell.mortgage;
      log(p.pawn+' hypotheque '+cell.name,'gain'); return true;
    }
    case 'unmortgage': {
      const pos=data.pos, cell=board[pos];
      const cost=Math.round(cell.mortgage*1.1);
      if(!gs.mortgaged.includes(pos)||p.money<cost) return false;
      gs.mortgaged=gs.mortgaged.filter(x=>x!==pos); p.money-=cost;
      log(p.pawn+' leve hypotheque '+cell.name,'loss'); return true;
    }
    case 'pay_jail': { if(!p.inJail||p.money<50) return false; p.money-=50;p.inJail=false;p.jailTurns=0; log(p.pawn+' paye M$50 prison.','loss'); return true; }
    case 'use_get_out': { if(!p.inJail||p.getOutCards<=0) return false; p.getOutCards--;p.inJail=false;p.jailTurns=0; log(p.pawn+' utilise carte prison.','gain'); return true; }
    case 'card_confirm': { gs.pendingCard=null; return true; }
    case 'end_turn': {
      if(gs.phase!=='action') return false;
      const rolledDoubles=gs.diceRoll&&gs.diceRoll[0]===gs.diceRoll[1]&&gs.doublesCount>0;
      if(rolledDoubles&&!p.inJail){log(p.pawn+' rejoue (doubles)!','chance');gs.phase='roll';gs.diceRoll=null;return true;}
      nextPlayer(gs,log); return true;
    }
    case 'bankrupt': {
      p.bankrupt=true; p.properties=[];
      log('🏳️ '+p.pawn+' '+p.name+' faillite!','loss');
      const alive=gs.players.filter(pl=>!pl.bankrupt);
      if(alive.length>1) nextPlayer(gs,log);
      return true;
    }
    default: return false;
  }
}

function goToJail(p,gs,log){p.pos=10;p.inJail=true;p.jailTurns=0;log('⛓️ '+p.pawn+' en prison!','loss');}
function isOwned(pos,gs){return gs.players.some(p=>p.properties.includes(pos));}
function ownerOf(pos,gs){return gs.players.find(p=>p.properties.includes(pos));}

function movePlayer(p,steps,board,gs,cards,log){
  const old=p.pos; p.pos=(p.pos+steps)%40;
  if(p.pos<old){p.money+=200;log(p.pawn+' passe Depart -> M$200','gain');}
  gs.phase='action';
  landOn(p,board,gs,cards,log);
}

function landOn(p,board,gs,cards,log){
  const cell=board[p.pos]; if(!cell) return;
  log(p.pawn+' -> '+cell.name,'move');
  switch(cell.type){
    case 'go': p.money+=200;log(p.pawn+' case Depart -> M$200','gain');break;
    case 'tax': p.money-=cell.price;log(p.pawn+' taxe M$'+cell.price,'loss');break;
    case 'goto_jail': goToJail(p,gs,log);break;
    case 'chance': applyCard(p,'chance',board,gs,cards,log);break;
    case 'community': applyCard(p,'community',board,gs,cards,log);break;
    case 'property': case 'station': case 'utility': handleRent(p,cell,board,gs,log);break;
  }
}

function applyCard(p,deck,board,gs,cards,log){
  const dc=deck==='chance'?cards.chance:cards.community;
  if(!dc||dc.length===0) return;
  const ok=deck==='chance'?'chanceOrder':'communityOrder', ik=deck==='chance'?'chanceIdx':'communityIdx';
  if(!gs[ok]||gs[ok].length===0) gs[ok]=shuffle([...Array(dc.length).keys()]);
  const card=dc[gs[ok][gs[ik]%gs[ok].length]]; gs[ik]++;
  gs.pendingCard=card;
  log(p.pawn+' carte '+deck+': "'+card.text+'"','chance');
  const others=gs.players.filter(pl=>!pl.bankrupt&&pl.id!==p.id);
  switch(card.effect){
    case 'gain': p.money+=card.amount;break;
    case 'lose': p.money-=card.amount;break;
    case 'goto_jail': goToJail(p,gs,log);break;
    case 'get_out': p.getOutCards++;log(p.pawn+' carte sortie prison.','gain');break;
    case 'move_to': {const t=card.targetPos||0;if(t<p.pos){p.money+=200;log(p.pawn+' passe Depart','gain');}p.pos=t;landOn(p,board,gs,cards,log);break;}
    case 'move_by': movePlayer(p,card.moveSteps||0,board,gs,cards,log);break;
    case 'repairs': {let tot=0;p.properties.forEach(pos=>{const b=gs.propertyBuildings[pos]||{houses:0,hotel:0};tot+=b.houses*(card.perHouse||0)+b.hotel*(card.perHotel||0);});p.money-=tot;log(p.pawn+' reparations M$'+tot,'loss');break;}
    case 'birthday': case 'collect_all': {const a=card.collectAmount||card.amount||0;others.forEach(o=>o.money-=a);p.money+=a*others.length;log(p.pawn+' collecte M$'+a*others.length,'gain');break;}
    case 'pay_all': {const a=card.amount||0;others.forEach(o=>o.money+=a);p.money-=a*others.length;log(p.pawn+' verse M$'+a*others.length,'loss');break;}
  }
}

function handleRent(p,cell,board,gs,log){
  const owner=ownerOf(cell.pos,gs);
  if(!owner||owner.id===p.id) return;
  if(gs.mortgaged.includes(cell.pos)){log(cell.name+' hypothequee.');return;}
  let rent=0;
  if(cell.type==='station'){const n=owner.properties.filter(pos=>board[pos]?.type==='station').length;rent=cell.rents[Math.min(n-1,3)]||25;}
  else if(cell.type==='utility'){const n=owner.properties.filter(pos=>board[pos]?.type==='utility').length;const d=gs.diceRoll?gs.diceRoll[0]+gs.diceRoll[1]:7;rent=n>=2?d*10:d*4;}
  else{const b=gs.propertyBuildings[cell.pos]||{houses:0,hotel:0};if(b.hotel)rent=cell.rents[5];else if(b.houses>0)rent=cell.rents[1+b.houses];else{const g=board.filter(c=>c.group===cell.group&&c.type==='property');rent=g.every(c=>owner.properties.includes(c.pos))?cell.rents[1]:cell.rents[0];}}
  p.money-=rent;owner.money+=rent;
  log(p.pawn+' loyer M$'+rent+' -> '+owner.pawn+' '+owner.name,'loss');
}

function nextPlayer(gs,log){
  gs.doublesCount=0;gs.diceRoll=null;
  let next=gs.currentPlayer;
  for(let i=0;i<gs.players.length;i++){next=(next+1)%gs.players.length;if(!gs.players[next].bankrupt)break;}
  if(next<=gs.currentPlayer) gs.turn++;
  gs.currentPlayer=next; gs.phase='roll';
  const np=gs.players[next];
  log('--- Tour de '+np.pawn+' '+np.name+' ---','system');
}

function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log('✅ Monopoly Custom sur http://localhost:'+PORT);
  console.log('   Reseau local : http://<votre-IP>:'+PORT);
});
