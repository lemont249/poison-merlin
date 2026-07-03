// ============================
// 毒药与梅林 - Supabase 联机版
// ============================
const SUPABASE_URL = 'https://catomgbmokxgrlcgxgsq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhdG9tZ2Jtb2t4Z3JsY2d4Z3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNDY3NTcsImV4cCI6MjA5ODYyMjc1N30.ileKS2UWUHbNAicOqqgLrCYx5Fg4g0k9k06TiELGeLE';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============ 全局状态 ============
let myName = '';
let myRole = null;
let myPlayerId = '';
let roomCode = '';
let isHost = false;
let dbChannel = null;    // 监听数据库变化
let actionChannel = null; // 接收客户端行动（房主用）
let gameData = null;

// ============ 工具函数 ============
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $('#screen-' + id);
  if (el) el.classList.add('active');
}

function showToast(msg, type) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast'; if (type) t.classList.add(type);
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function getRoleInfo(key) {
  const m = {
    merlin:   { name:'梅林', icon:'🧙‍♂️', side:'good', sideLabel:'好人阵营', desc:'免疫投毒和解毒负面效果。知道谁是投毒者。' },
    mage:     { name:'法师', icon:'🧙', side:'good', sideLabel:'好人阵营', desc:'夜晚可对一人施法解毒；若对方未中毒，则反噬中毒。也可不行动。' },
    sage:     { name:'知者', icon:'📊', side:'good', sideLabel:'好人阵营', desc:'知道本轮白天的中毒总人数。' },
    loyalist: { name:'忠臣', icon:'🛡️', side:'good', sideLabel:'好人阵营', desc:'知道谁是梅林。' },
    poisoner: { name:'投毒者', icon:'☠️', side:'evil', sideLabel:'坏人阵营', desc:'夜晚可投毒一人。知道一张未入局的好人身份。' },
  };
  return m[key] || { name:'未知', icon:'❓', side:'', sideLabel:'', desc:'' };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10);
  return code;
}

function genId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

// ============ 游戏逻辑 ============
function createGameState(players) {
  const inPlay = ['merlin'];
  const otherGood = ['mage', 'sage', 'loyalist'];
  shuffle(otherGood);
  inPlay.push(otherGood[0], otherGood[1]);
  const unused = otherGood[2];
  inPlay.push('poisoner');
  shuffle(inPlay);

  const playersWithRoles = players.map((p, i) => ({ ...p, role: inPlay[i] }));
  shuffle(playersWithRoles);

  return {
    players: playersWithRoles,
    unusedRole: unused,
    phase: 'lobby',     // lobby | role-reveal | night-poisoner | night-mage | night-info | game-over
    round: 1,
    poisonerTarget: null,
    mageTarget: null,
    merlinPoisonCount: 0,
    poisonList: [],
    gameOver: false,
    winner: null,
    winReason: null,
    confirmedPlayers: [],
  };
}

function getPlayerView(gs, playerId) {
  const player = gs.players.find(p => p.id === playerId);
  if (!player) return null;

  const view = {
    myRole: player.role,
    myName: player.name,
    phase: gs.phase,
    round: gs.round,
    maxRounds: 5,
    gameOver: gs.gameOver,
    winner: gs.winner,
    winReason: gs.winReason,
    players: gs.players.map(p => ({ id: p.id, name: p.name, role: p.id === playerId ? p.role : undefined })),
  };

  if (player.role === 'poisoner' && gs.unusedRole) view.unusedRole = getRoleInfo(gs.unusedRole);
  if (player.role === 'merlin') {
    const po = gs.players.find(p => p.role === 'poisoner');
    if (po) view.merlinInfo = { poisonerName: po.name };
  }
  if (player.role === 'sage' && gs.phase === 'night-info') view.sageInfo = { poisonCount: gs.poisonList.length };
  if (player.role === 'loyalist') {
    const me = gs.players.find(p => p.role === 'merlin');
    if (me) view.loyalistInfo = { merlinName: me.name };
  }
  if (gs.phase === 'night-poisoner' && player.role === 'poisoner') {
    view.canAct = true; view.actionType = 'poison';
    view.targets = gs.players.filter(p => p.id !== playerId).map(p => ({ id: p.id, name: p.name }));
  }
  if (gs.phase === 'night-mage' && player.role === 'mage') {
    view.canAct = true; view.actionType = 'detox';
    view.targets = gs.players.filter(p => p.id !== playerId).map(p => ({ id: p.id, name: p.name }));
  }
  view.needConfirm = !gs.confirmedPlayers.includes(playerId);
  return view;
}

function resolveNight(gs) {
  gs.poisonList = [];
  const merlin = gs.players.find(p => p.role === 'merlin');
  const poisonTarget = gs.players.find(p => p.id === gs.poisonerTarget);
  const mageTarget = gs.players.find(p => p.id === gs.mageTarget);

  if (poisonTarget && poisonTarget.role !== 'merlin') gs.poisonList.push(poisonTarget.id);
  if (mageTarget) {
    const wasPoisoned = gs.poisonList.includes(mageTarget.id);
    if (wasPoisoned) gs.poisonList = gs.poisonList.filter(id => id !== mageTarget.id);
    else if (mageTarget.role !== 'merlin') gs.poisonList.push(mageTarget.id);
  }
  if (gs.poisonerTarget && merlin && gs.poisonerTarget === merlin.id) {
    gs.merlinPoisonCount++;
    if (gs.merlinPoisonCount >= 3) {
      gs.gameOver = true; gs.winner = 'evil';
      gs.winReason = '投毒者累计三次选中梅林，坏人直接获胜！';
      gs.phase = 'game-over'; return;
    }
  }
  gs.phase = 'night-info';
}

function advanceRound(gs) {
  gs.round++;
  if (gs.round > 5) {
    gs.gameOver = true; gs.winner = 'good';
    gs.winReason = '五轮任务结束，进入处决阶段（线下进行）';
    gs.phase = 'game-over';
  } else {
    gs.phase = 'night-poisoner';
    gs.poisonerTarget = null; gs.mageTarget = null;
    gs.poisonList = []; gs.confirmedPlayers = [];
  }
}

// ============ 数据库读写 ============
async function saveState() {
  if (!isHost || !roomCode) return;
  const { error } = await db.from('games').upsert({ room_code: roomCode, state: gameData });
  if (error) console.error('Save error:', error);
}

async function loadState(code) {
  const { data, error } = await db.from('games').select('state').eq('room_code', code).single();
  if (error || !data) return null;
  return data.state;
}

// ============ 房主：处理收到的行动 ============
function processAction(gs, action) {
  // action: { playerId, type, [targetId], [actionType] }
  if (action.type === 'confirm') {
    if (!gs.confirmedPlayers.includes(action.playerId)) {
      gs.confirmedPlayers.push(action.playerId);
    }
    checkPhaseTransition(gs);
    return;
  }

  if (action.type === 'night-action') {
    if (gs.phase === 'night-poisoner' && action.actionType === 'poison') {
      gs.poisonerTarget = action.targetId || null;
      gs.phase = 'night-mage';
      gs.confirmedPlayers = [];
    } else if (gs.phase === 'night-mage' && action.actionType === 'detox') {
      gs.mageTarget = action.targetId || null;
      resolveNight(gs);
      gs.confirmedPlayers = [];
    }
    return;
  }
}

function checkPhaseTransition(gs) {
  const allIds = gs.players.map(p => p.id);
  const allConfirmed = allIds.every(id => gs.confirmedPlayers.includes(id));

  if (allConfirmed && gs.phase === 'role-reveal') {
    gs.phase = 'night-poisoner';
    gs.confirmedPlayers = [];
  } else if (allConfirmed && gs.phase === 'night-info') {
    advanceRound(gs);
  }
}

// ============ 实时订阅 ============
function setupRealtime() {
  // 所有人都监听数据库变化
  dbChannel = db.channel('db-' + roomCode)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'games',
      filter: 'room_code=eq.' + roomCode,
    }, (payload) => {
      const newState = payload.new?.state;
      if (newState) {
        gameData = newState;
        updateUI();
      }
    })
    .subscribe();

  // 创建 action 广播频道（所有人都创建，保持同一频道名）
  actionChannel = db.channel('act-' + roomCode)
    .on('broadcast', { event: 'action' }, (payload) => {
      // 只有房主处理收到的 action
      if (!isHost || !gameData) return;
      processAction(gameData, payload.payload);
      saveState();
    })
    .subscribe();
}

// ============ 客户端发送行动 ============
function sendAction(action) {
  // actionChannel 已在 setupRealtime 中创建，直接用
  if (actionChannel) {
    actionChannel.send({
      type: 'broadcast',
      event: 'action',
      payload: { ...action, playerId: myPlayerId },
    });
  }
}

// ============ 本地行动（房主自己） ============
function hostDoAction(action) {
  if (!gameData) return;
  processAction(gameData, { ...action, playerId: myPlayerId });
  saveState();
}

// ============ UI 更新 ============
function updateUI() {
  if (!gameData) return;
  const gs = gameData;

  // lobby 特殊处理
  if (gs.phase === 'lobby') {
    updateLobbyUI();
    return;
  }

  const view = getPlayerView(gs, myPlayerId);
  if (!view) return;
  myRole = view.myRole;

  switch (view.phase) {
    case 'role-reveal': showRoleRevealUI(view); break;
    case 'night-poisoner':
      view.canAct ? showActionUI(view, 'poison') : showWaitingUI(view);
      break;
    case 'night-mage':
      view.canAct ? showActionUI(view, 'detox') : showWaitingUI(view);
      break;
    case 'night-info': showNightInfoUI(view); break;
    case 'game-over': showGameOverUI(view); break;
  }
}

function showRoleRevealUI(view) {
  showScreen('role-reveal');
  const role = getRoleInfo(view.myRole);
  $('#role-icon').textContent = role.icon;
  $('#role-name').textContent = role.name;
  $('#role-side').textContent = role.sideLabel;
  $('#role-side').className = 'role-side ' + role.side;
  $('#role-desc').textContent = role.desc;

  let h = '';
  if (view.unusedRole) h += `<p>📋 未入局身份：<strong>${view.unusedRole.name}</strong></p>`;
  if (view.merlinInfo) h += `<p>👁️ 投毒者是：<strong>${view.merlinInfo.poisonerName}</strong></p>`;
  if (view.loyalistInfo) h += `<p>👑 梅林是：<strong>${view.loyalistInfo.merlinName}</strong></p>`;
  const el = $('#role-extra-info');
  if (h) { el.innerHTML = h; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

function showWaitingUI(view) {
  showScreen('night-waiting');
  $('#round-num-waiting').textContent = view.round;
  $('#waiting-reason').textContent =
    view.phase === 'night-poisoner' ? '等待投毒者行动…' :
    view.phase === 'night-mage' ? '等待法师行动…' : '等待其他玩家…';
}

function showActionUI(view, actionType) {
  showScreen('night-action');
  $('#round-num-action').textContent = view.round;

  if (actionType === 'poison') {
    $('#action-title').textContent = '☠️ 投毒者行动';
    $('#action-desc').textContent = '选择一名玩家投毒（中毒者白天被迫破坏）';
    $('#action-hint').textContent = '梅林免疫投毒';
  } else {
    $('#action-title').textContent = '🧙 法师行动';
    $('#action-desc').textContent = '若认为某人被投毒，对其施法解毒';
    $('#action-hint').textContent = '⚠️ 若对方未中毒，毒药将反噬（梅林免疫）';
  }

  const div = $('#action-targets');
  div.innerHTML = '';
  view.targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.textContent = '👤 ' + t.name;
    btn.addEventListener('click', () => doAction(actionType, t.id));
    div.appendChild(btn);
  });

  $('#btn-action-skip').onclick = () => doAction(actionType, null);
}

function showNightInfoUI(view) {
  showScreen('night-info');
  $('#round-num-info').textContent = view.round;
  const role = getRoleInfo(view.myRole);
  let h = '';
  if (view.merlinInfo) h = `<p>👁️ 你是<strong>${role.name}</strong></p><p>投毒者：<strong>${view.merlinInfo.poisonerName}</strong></p>`;
  else if (view.loyalistInfo) h = `<p>👑 你是<strong>${role.name}</strong></p><p>梅林：<strong>${view.loyalistInfo.merlinName}</strong></p>`;
  else if (view.sageInfo !== undefined) h = `<p>📊 你是<strong>${role.name}</strong></p><p>中毒人数：<strong>${view.sageInfo.poisonCount}</strong> 人</p>`;
  else if (view.myRole === 'poisoner') h = `<p>☠️ 你是<strong>${role.name}</strong></p><p>行动完成，等待白天…</p>`;
  else if (view.myRole === 'mage') h = `<p>🧙 你是<strong>${role.name}</strong></p><p>法术已施放，等待白天…</p>`;
  else h = `<p>你是<strong>${role.name}</strong></p><p>等待白天…</p>`;
  $('#night-info-content').innerHTML = h;
}

function showGameOverUI(view) {
  showScreen('game-over');
  if (view.winner === 'evil') {
    $('#game-over-title').textContent = '💀 坏人获胜';
    $('#game-over-icon').textContent = '💀';
  } else {
    $('#game-over-title').textContent = '🏆 游戏结束';
    $('#game-over-icon').textContent = '🎉';
  }
  $('#game-over-reason').textContent = view.winReason || '';
  let detail = '最终身份：\n';
  if (view.players) {
    detail = view.players.map(p => { const r = getRoleInfo(p.role); return `${p.name}: ${r.icon} ${r.name}`; }).join('\n');
  }
  $('#game-over-detail').textContent = detail;
}

// ============ 执行行动 ============
function doAction(actionType, targetId) {
  const action = { type: 'night-action', actionType, targetId };

  if (isHost) {
    hostDoAction(action);
    showScreen('night-waiting');
    $('#waiting-reason').textContent = '等待其他玩家…';
  } else {
    sendAction(action);
    showScreen('night-waiting');
    $('#waiting-reason').textContent = '等待房主处理…';
  }
}

function doConfirm() {
  if (isHost) {
    hostDoAction({ type: 'confirm' });
  } else {
    sendAction({ type: 'confirm' });
  }
  // 切换到等待界面，等 dbChannel 推送新状态
  if (gameData && gameData.phase !== 'game-over') {
    showScreen('night-waiting');
    $('#waiting-reason').textContent = '等待所有玩家确认…';
  }
}

// ============ 大厅 ============
function updateLobbyUI() {
  if (!gameData) return;
  showScreen('lobby');
  const players = gameData.players;
  $('#lobby-room-code').textContent = roomCode;
  $('#lobby-player-list').innerHTML = players.map(p =>
    `<li><span class="player-dot"></span> ${escapeHtml(p.name)} ${p.id === myPlayerId ? '(我)' : ''}</li>`
  ).join('');

  if (isHost) {
    $('#btn-start-game').style.display = '';
    $('#lobby-start-hint').style.display = '';
    $('#btn-start-game').disabled = players.length !== 4;
    $('#lobby-start-hint').textContent = players.length === 4 ? '可以开始了！' : '仅房主可开始';
  } else {
    $('#btn-start-game').style.display = 'none';
    $('#lobby-start-hint').textContent = '等待房主开始…';
    $('#lobby-start-hint').style.display = '';
  }
}

// ============ 事件绑定 ============
$('#btn-create').addEventListener('click', async () => {
  myName = $('#input-player-name').value.trim() || '房主';
  myPlayerId = genId();
  isHost = true;
  roomCode = generateRoomCode();

  // 确保房间号不冲突
  const existing = await loadState(roomCode);
  if (existing) roomCode = generateRoomCode();

  gameData = {
    players: [{ id: myPlayerId, name: myName, role: null }],
    phase: 'lobby',
    round: 1,
    poisonerTarget: null, mageTarget: null,
    merlinPoisonCount: 0, poisonList: [],
    gameOver: false, winner: null, winReason: null,
    confirmedPlayers: [],
    unusedRole: null,
  };

  await db.from('games').upsert({ room_code: roomCode, state: gameData });
  setupRealtime();
  updateLobbyUI();
});

$('#btn-join').addEventListener('click', () => $('#join-section').classList.toggle('hidden'));
$('#btn-join-cancel').addEventListener('click', () => $('#join-section').classList.add('hidden'));

$('#btn-join-submit').addEventListener('click', async () => {
  const code = $('#input-room-code').value.trim();
  myName = $('#input-player-name').value.trim() || '玩家';
  if (!code || code.length !== 4) { showToast('请输入4位房间号', 'error'); return; }

  const gs = await loadState(code);
  if (!gs) { showToast('房间不存在', 'error'); return; }
  if (gs.players.length >= 4) { showToast('房间已满（4人）', 'error'); return; }
  if (gs.phase !== 'lobby') { showToast('游戏已开始', 'error'); return; }
  if (gs.players.some(p => p.name === myName)) { showToast('昵称已被占用', 'error'); return; }

  myPlayerId = genId();
  isHost = false;
  roomCode = code;

  gs.players.push({ id: myPlayerId, name: myName, role: null });
  await db.from('games').upsert({ room_code: code, state: gs });
  gameData = gs;
  setupRealtime();
  updateLobbyUI();
});

$('#btn-start-game').addEventListener('click', async () => {
  if (!isHost || !gameData || gameData.players.length !== 4) return;

  const players = gameData.players.map(p => ({ id: p.id, name: p.name }));
  gameData = createGameState(players);
  await db.from('games').upsert({ room_code: roomCode, state: gameData });
  // updateUI 会由 dbChannel 触发
});

$('#btn-confirm-role').addEventListener('click', doConfirm);
$('#btn-confirm-info').addEventListener('click', doConfirm);

$('#btn-new-game').addEventListener('click', () => {
  if (dbChannel) db.removeChannel(dbChannel);
  if (actionChannel) db.removeChannel(actionChannel);
  isHost = false; roomCode = ''; gameData = null;
  showScreen('home');
});

// ============ 重连支持 ============
// 如果页面刷新，从 URL 恢复（暂不支持，可后续加）
