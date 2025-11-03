const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');
const crypto=require('crypto');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:["https://thezone.lv","https://www.thezone.lv","https://duraks.thezone.lv","*"]}});

app.use(express.static(path.join(__dirname,"public")));

const SUITS=['♠','♥','♦','♣'];
const R36=['6','7','8','9','10','J','Q','K','A'];
const R52=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV=Object.fromEntries(R52.map((r,i)=>[r,i]));

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(0,i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
function makeDeck(n){const ranks=(n===36)?R36:R52;const d=[];for(const s of SUITS){for(const r of ranks){d.push({r,s})}}return shuffle(d)}
function beats(a,b,trump){if(a.s===b.s&&RV[a.r]>RV[b.r])return true; if(a.s===trump&&b.s!==trump)return true; return false}
function lowestTrump(hand,trump){return hand.filter(c=>c.s===trump).sort((a,b)=>RV[a.r]-RV[b.r])[0]}

const rooms=new Map();
const tokenIndex=new Map();

function code(){const abc='ABCDEFGHJKMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<5;i++)s+=abc[Math.floor(Math.random()*abc.length)];return s}
function makeRoom(deckSize){const c=code();rooms.set(c,{code:c,deckSize,deck:[],trump:null,players:[],table:[],attacker:null,defender:null,phase:'lobby',timer:null,lastActionTs:Date.now(),lastOutcome:null});return rooms.get(c)}
function deal(room){
  room.deck=makeDeck(room.deckSize);
  room.trump=room.deck[room.deck.length-1].s;
  room.players.forEach(p=>{p.hand=[];p.lastChatTime=0});
  for(let i=0;i<6;i++)for(const p of room.players){p.hand.push(room.deck.shift())}
  const lt=room.players.map(p=>({p,lt:lowestTrump(p.hand,room.trump)})).sort((a,b)=>{if(!a.lt&&!b.lt)return 0;if(!a.lt)return 1;if(!b.lt)return -1;return RV[a.lt.r]-RV[b.lt.r]})[0].p;
  room.attacker=lt.id;
  room.defender=room.players.find(p=>p.id!==lt.id).id;
  room.table=[];room.phase='attack';
  startTurnTimer(room);
}
function baseRanks(room){const set=new Set();room.table.forEach(p=>{set.add(p.atk.r);if(p.def)set.add(p.def.r)});return set}
function canAddMore(room){const def=room.players.find(p=>p.id===room.defender);const limit=Math.min(6,def.hand.length);return room.table.length<limit}
function drawUpTo6(room,id){const P=room.players.find(p=>p.id===id);while(P&&P.hand.length<6&&room.deck.length)P.hand.push(room.deck.shift())}
function sync(room){
  const payload={code:room.code,trump:{s:room.trump},stock:room.deck.length,players:room.players.map(p=>({id:p.id,nick:p.nick,hand:p.hand.map(c=>c),handCount:p.hand.length})),table:room.table.map(t=>({atk:t.atk,def:t.def||null})),attacker:room.attacker,defender:room.defender,phase:room.phase};
  room.players.forEach(p=>{const per=JSON.parse(JSON.stringify(payload));per.players.forEach(q=>{if(q.id!==p.id)q.hand=q.hand.map(()=>({hidden:true}))});io.to(p.id).emit('game.state',per)})
}
function startTurnTimer(room){
  stopTurnTimer(room);
  const D=30000;room.timer={deadline:Date.now()+D};
  room.timer._int=setInterval(()=>{const ms=Math.max(0,room.timer.deadline-Date.now());const who=(room.phase==='defend')?room.defender:room.attacker;io.to(room.code).emit('timer.tick',{msLeft:ms,who,phase:room.phase});if(ms<=0){clearInterval(room.timer._int);room.timer._int=null;onTimerExpire(room)}},1000)
}
function stopTurnTimer(room){if(room.timer&&room.timer._int){clearInterval(room.timer._int);room.timer._int=null}}
function onTimerExpire(room){
  if(room.phase==='defend'){takeCards(room,room.defender)}
  else if(room.phase==='attack'){if(room.table.length&&room.table.every(p=>p.def))endAttack(room);else{switchRoles(room);room.phase='attack';sync(room);startTurnTimer(room)}}
}
function switchRoles(room){const o=room.attacker;room.attacker=room.defender;room.defender=o}
function endAttack(room){
  if(!room.table.length||!room.table.every(p=>p.def))return;
  room.table=[];room.lastOutcome='defended';
  drawUpTo6(room,room.attacker);drawUpTo6(room,room.defender);
  switchRoles(room);room.phase='attack';
  checkOver(room);sync(room);if(room.phase!=='over')startTurnTimer(room)
}
function takeCards(room,defId){
  const D=room.players.find(p=>p.id===defId);
  room.table.forEach(p=>{D.hand.push(p.atk);if(p.def)D.hand.push(p.def)});
  room.table=[];room.lastOutcome='taken';
  io.to(room.code).emit('game.taken');
  room.attacker=room.players.find(p=>p.id!==defId).id;
  room.defender=defId;
  drawUpTo6(room,room.attacker);drawUpTo6(room,room.defender);
  room.phase='attack';
  checkOver(room);sync(room);if(room.phase!=='over')startTurnTimer(room)
}
function checkOver(room){
  const a=room.players[0]?.hand.length??0;
  const b=room.players[1]?.hand.length??0;
  if(a===0&&b===0){room.phase='over';stopTurnTimer(room)}
  else if(a===0||b===0){room.phase='over';stopTurnTimer(room)}
}

io.on('connection',sock=>{
  sock.on('session.hello',({token})=>{const found=tokenIndex.get(token);if(found){const r=rooms.get(found.room);if(r){const P=r.players.find(p=>p.id===found.playerId);if(P){P.id=sock.id;sock.join(r.code);io.to(sock.id).emit('session.rejoin.ok',{room:r.code,nick:P.nick});sync(r);return}}}})
  sock.on('room.create',({nick,deckSize,token})=>{const r=makeRoom(deckSize===52?52:36);const p={id:sock.id,nick:nick||'Spēlētājs',token:token||null,hand:[],lastChatTime:0};r.players.push(p);sock.join(r.code);if(token)tokenIndex.set(token,{room:r.code,playerId:sock.id});io.to(sock.id).emit('room.created',{room:r.code});io.to(r.code).emit('room.update',{players:r.players.map(x=>({id:x.id,nick:x.nick}))})});
  sock.on('room.join',({nick,room,token})=>{const r=rooms.get(room);if(!r)return io.to(sock.id).emit('error.msg','Istaba neeksistē');if(r.players.length>=2)return io.to(sock.id).emit('error.msg','Istaba pilna');const p={id:sock.id,nick:nick||'Spēlētājs',token:token||null,hand:[],lastChatTime:0};r.players.push(p);sock.join(room);if(token)tokenIndex.set(token,{room,playerId:sock.id});io.to(sock.id).emit('room.joined',{room,players:r.players.map(x=>({id:x.id,nick:x.nick}))});io.to(room).emit('room.update',{players:r.players.map(x=>({id:x.id,nick:x.nick}))})});
  sock.on('game.start',({room})=>{const r=rooms.get(room);if(!r)return;if(r.players.length!==2)return io.to(sock.id).emit('error.msg','Nepieciešami 2 spēlētāji');deal(r);sync(r)});
  sock.on('game.play',({room,idx,defendIdx})=>{const r=rooms.get(room);if(!r)return;const P=r.players.find(p=>p.id===sock.id);if(!P)return;r.lastActionTs=Date.now();if(r.phase==='attack'&&r.attacker===sock.id){if(!canAddMore(r))return io.to(sock.id).emit('error.msg','Metiena limits');const bases=baseRanks(r);const c=P.hand[idx];if(!c)return;if(r.table.length===0||bases.has(c.r)){P.hand.splice(idx,1);r.table.push({atk:c});r.phase='defend';sync(r);startTurnTimer(r)}else io.to(sock.id).emit('error.msg','Drīkst mest tikai esošos ciparus')}else if(r.phase==='defend'&&r.defender===sock.id){const ti=(Number.isInteger(defendIdx)?defendIdx:r.table.findIndex(t=>!t.def));const target=r.table[ti];if(!target||target.def)return;const c=P.hand[idx];if(!c)return;if(beats(c,target.atk,r.trump)){P.hand.splice(idx,1);target.def=c;sync(r);if(r.table.every(p=>p.def)){r.phase='attack';sync(r);startTurnTimer(r)}}else io.to(sock.id).emit('error.msg','Šī kārts nenosit')}});
  sock.on('game.take',({room})=>{const r=rooms.get(room);if(!r)return;if(r.defender!==sock.id||r.phase!=='defend')return;r.lastActionTs=Date.now();takeCards(r,sock.id)});
  sock.on('game.endAttack',({room})=>{const r=rooms.get(room);if(!r)return;if(r.attacker!==sock.id)return;r.lastActionTs=Date.now();endAttack(r)});
  sock.on('game.pass',({room})=>{const r=rooms.get(room);if(!r)return;if(r.attacker!==sock.id)return;if(r.table.length&&r.table.every(p=>p.def)){r.lastActionTs=Date.now();endAttack(r)}});
  sock.on('chat',({room,msg})=>{const r=rooms.get(room);if(!r)return;const P=r.players.find(p=>p.id===sock.id);if(!P)return;const now=Date.now();if(now-(P.lastChatTime||0)<1000)return io.to(sock.id).emit('error.msg','Tu sūti ziņas pārāk bieži');P.lastChatTime=now;const n=P.nick||'Anon';io.to(room).emit('chat',{nick:n,msg:String(msg).slice(0,300)})});
  sock.on('disconnect',()=>{});
});

setInterval(()=>{const now=Date.now();for(const [c,r] of rooms){const has=r.players.some(p=>io.sockets.sockets.get(p.id));if(!has&&now-r.lastActionTs>300000){rooms.delete(c)}}},60000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Duraks Online server listening on '+PORT));
