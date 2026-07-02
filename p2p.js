// ============================
// 毒药与梅林 - P2P 版本
// 房主浏览器 = 服务器
// ============================

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ============ 全局状态 ============
let isHost = false;
let myName = '';
let myRole = null;
let currentView = null;

// WebRTC
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let hostConnections = [];  // [{pc, dc, playerName, index}] - host only
let hostDC = null;         // client's data channel to host
let hostPC = null;         // client's peer connection to host

// Game state (host only)
let gameState = null;

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
    mage:     { name:'法师', icon:'🧙', side:'good', sideLabel:'好人阵营', desc:'夜晚可对一人施法解毒；若对方未中毒，则反噬中毒。' },
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

// ============ WebRTC: 房主端 ============
async function hostCreateOffer(slotIndex) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  const dc = pc.createDataChannel('game');

  return new Promise((resolve, reject) => {
    let resolved = false;

    dc.onopen = () => {
      console.log(`[Host] Slot ${slotIndex} data channel opened`);
      const conn = hostConnections[slotIndex];
      if (conn) conn.connected = true;
      updateHostSlotsUI();
    };

    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleHostMessage(slotIndex, msg);
    };

    dc.onclose = () => {
      console.log(`[Host] Slot ${slotIndex} disconnected`);
      const conn = hostConnections[slotIndex];
      if (conn) conn.connected = false;
      updateHostSlotsUI();
    };

    pc.onicecandidate = () => {}; // trickle candidates will be bundled

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        // Wait for ICE gathering
        checkICE(pc, () => {
          if (resolved) return;
          resolved = true;
          hostConnections[slotIndex] = { pc, dc, playerName: '', connected: false, index: slotIndex };
          const offerStr = btoa(JSON.stringify(pc.localDescription));
          resolve(offerStr);
        });
      })
      .catch(reject);
  });
}

function checkICE(pc, cb) {
  if (pc.iceGatheringState === 'complete') { cb(); return; }
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') cb();
  };
  // Timeout fallback after 5s
  setTimeout(() => {
    if (pc.iceGatheringState !== 'complete') cb();
  }, 5000);
}

async function hostReceiveAnswer(slotIndex, answerStr) {
  const conn = hostConnections[slotIndex];
  if (!conn) return false;
  try {
    const answer = JSON.parse(atob(answerStr));
    await conn.pc.setRemoteDescription(answer);
    return true;
  } catch (e) {
    console.error('Invalid answer:', e);
    return false;
  }
}

function hostBroadcast(msg) {
  hostConnections.forEach(conn => {
    if (conn && conn.connected && conn.dc.readyState === 'open') {
      conn.dc.send(JSON.stringify(msg));
    }
  });
}

function hostSendTo(slotIndex, msg) {
  const conn = hostConnections[slotIndex];
  if (conn && conn.connected && conn.dc.readyState === 'open') {
    conn.dc.send(JSON.stringify(msg));
  }
}

// ============ WebRTC: 客户端 ============
async function clientConnect(offerStr) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  hostPC = pc;

  return new Promise((resolve, reject) => {
    let resolved = false;

    pc.ondatachannel = (e) => {
      hostDC = e.channel;
      hostDC.onopen = () => {
        console.log('[Client] Data channel opened');
        hostDC.send(JSON.stringify({ type: 'join', name: myName }));
      };
      hostDC.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        handleClientMessage(msg);
      };
      hostDC.onclose = () => {
        showToast('与房主断开连接', 'error');
      };
    };

    pc.onicecandidate = () => {};

    const offer = JSON.parse(atob(offerStr));
    pc.setRemoteDescription(offer)
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        checkICE(pc, () => {
          if (resolved) return;
          resolved = true;
          const answerStr = btoa(JSON.stringify(pc.localDescription));
          resolve(answerStr);
        });
      })
      .catch(reject);
  });
}

// ============ 游戏逻辑（房主端） ============
function createGameState(playerNames) {
  // 分配身份（梅林必入局，和原版 server.js 一样）
  const inPlay = ['merlin'];
  const otherGood = ['mage', 'sage', 'loyalist'];
  shuffle(otherGood);
  inPlay.push(otherGood[0], otherGood[1]);
  const unused = otherGood[2];
  inPlay.push('poisoner');
  shuffle(inPlay);

  const players = playerNames.map((name, i) => ({
    name,
    role: inPlay[i],
    slotIndex: i,
  }));

  // 加上房主自己
  players.push({ name: myName, role: inPlay[3], slotIndex: -1 });
  // 重新洗牌，让房主位置随机
  shuffle(players);

  return {
    players,
    unusedRole: unused,
    phase: 'role-reveal',
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

function getClientView(gs, playerName) {
  const player = gs.players.find(p => p.name === playerName);
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
    players: gs.players.map(p => ({ name: p.name, role: p.name === playerName ? p.role : undefined })),
  };

  // 投毒者看到未入局身份
  if (player.role === 'poisoner' && gs.unusedRole) {
    view.unusedRole = getRoleInfo(gs.unusedRole);
  }

  // 梅林看到投毒者
  if (player.role === 'merlin') {
    const poisoner = gs.players.find(p => p.role === 'poisoner');
    if (poisoner) view.merlinInfo = { poisonerName: poisoner.name };
  }

  // 知者看到中毒人数
  if (player.role === 'sage' && gs.phase === 'night-info') {
    view.sageInfo = { poisonCount: gs.poisonList.length };
  }

  // 忠臣看到梅林
  if (player.role === 'loyalist') {
    const merlin = gs.players.find(p => p.role === 'merlin');
    if (merlin) view.loyalistInfo = { merlinName: merlin.name };
  }

  // 可行动标记
  if (gs.phase === 'night-poisoner' && player.role === 'poisoner') {
    view.canAct = true;
    view.actionType = 'poison';
    view.targets = gs.players.filter(p => p.name !== playerName).map(p => ({ name: p.name }));
  }
  if (gs.phase === 'night-mage' && player.role === 'mage') {
    view.canAct = true;
    view.actionType = 'detox';
    view.targets = gs.players.filter(p => p.name !== playerName).map(p => ({ name: p.name }));
  }

  view.needConfirm = !gs.confirmedPlayers.includes(playerName);

  return view;
}

function resolveNight(gs) {
  gs.poisonList = [];
  const merlin = gs.players.find(p => p.role === 'merlin');
  const poisonTarget = gs.players.find(p => p.name === gs.poisonerTarget);
  const mageTarget = gs.players.find(p => p.name === gs.mageTarget);

  // 投毒（梅林免疫）
  if (poisonTarget && poisonTarget.role !== 'merlin') {
    gs.poisonList.push(poisonTarget.name);
  }

  // 解毒
  if (mageTarget) {
    const wasPoisoned = gs.poisonList.includes(mageTarget.name);
    if (wasPoisoned) {
      gs.poisonList = gs.poisonList.filter(n => n !== mageTarget.name);
    } else if (mageTarget.role !== 'merlin') {
      gs.poisonList.push(mageTarget.name);
    }
  }

  // 投毒梅林计数
  if (gs.poisonerTarget && merlin && gs.poisonerTarget === merlin.name) {
    gs.merlinPoisonCount++;
    if (gs.merlinPoisonCount >= 3) {
      gs.gameOver = true;
      gs.winner = 'evil';
      gs.winReason = '投毒者累计三次选中梅林，坏人直接获胜！';
      gs.phase = 'game-over';
      return;
    }
  }

  gs.phase = 'night-info';
}

function advanceRound(gs) {
  gs.round++;
  if (gs.round > 5) {
    gs.gameOver = true;
    gs.winner = 'good';
    gs.winReason = '五轮任务结束，进入处决阶段（线下进行）';
    gs.phase = 'game-over';
  } else {
    gs.phase = 'night-poisoner';
    gs.poisonerTarget = null;
    gs.mageTarget = null;
    gs.poisonList = [];
    gs.confirmedPlayers = [];
  }
}

function broadcastPhase(gs) {
  // 给每个玩家发送他们的专属视角
  gs.players.forEach(p => {
    const view = getClientView(gs, p.name);
    // 找到对应连接并发送
    if (p.name === myName) {
      // 这是房主自己
      handlePhaseChange(view);
    } else {
      const conn = hostConnections.find(c => c && c.playerName === p.name);
      if (conn) hostSendTo(conn.index, { type: 'phase-change', view });
    }
  });
}

// ============ 消息处理：房主端 ============
function handleHostMessage(slotIndex, msg) {
  switch (msg.type) {
    case 'join':
      hostConnections[slotIndex].playerName = msg.name;
      console.log(`[Host] Player ${msg.name} joined slot ${slotIndex}`);
      updateHostSlotsUI();
      break;

    case 'confirm-phase':
      if (!gameState) break;
      if (!gameState.confirmedPlayers.includes(msg.name)) {
        gameState.confirmedPlayers.push(msg.name);
      }
      checkAllConfirmed();
      break;

    case 'night-action':
      handleNightAction(msg);
      break;
  }
}

function checkAllConfirmed() {
  const gs = gameState;
  if (!gs) return;

  const allPlayers = gs.players.map(p => p.name);
  const allConfirmed = allPlayers.every(n => gs.confirmedPlayers.includes(n));

  if (allConfirmed && gs.phase === 'role-reveal') {
    gs.phase = 'night-poisoner';
    gs.confirmedPlayers = [];
    broadcastPhase(gs);
  } else if (allConfirmed && gs.phase === 'night-info') {
    advanceRound(gs);
    broadcastPhase(gs);
  }
}

function handleNightAction(msg) {
  const gs = gameState;
  if (!gs) return;

  if (gs.phase === 'night-poisoner' && msg.actionType === 'poison') {
    gs.poisonerTarget = msg.targetId || null;
    gs.confirmedPlayers.push(msg.name);
    gs.phase = 'night-mage';
    broadcastPhase(gs);

  } else if (gs.phase === 'night-mage' && msg.actionType === 'detox') {
    gs.mageTarget = msg.targetId || null;
    gs.confirmedPlayers.push(msg.name);
    resolveNight(gs);
    gs.confirmedPlayers = [];
    broadcastPhase(gs);
  }
}

// ============ 房主自己确认 ============
function hostSelfConfirm() {
  if (!gameState) return;
  if (!gameState.confirmedPlayers.includes(myName)) {
    gameState.confirmedPlayers.push(myName);
  }
  hostBroadcast({ type: 'host-confirmed', name: myName });
  checkAllConfirmed();
}

function hostSelfAction(actionType, targetName) {
  if (!gameState) return;
  const msg = { type: 'night-action', name: myName, actionType, targetId: targetName || null };
  handleNightAction(msg);
}

// ============ 消息处理：客户端 ============
function handleClientMessage(msg) {
  switch (msg.type) {
    case 'phase-change':
      handlePhaseChange(msg.view);
      break;
    case 'host-confirmed':
      // 房主确认的广播
      break;
  }
}

// ============ UI: 屏幕管理 ============
function handlePhaseChange(view) {
  currentView = view;
  myRole = view.myRole;

  switch (view.phase) {
    case 'role-reveal':
      showRoleReveal(view);
      break;
    case 'night-poisoner':
      if (view.canAct) showActionScreen(view, 'poison');
      else showWaiting(view);
      break;
    case 'night-mage':
      if (view.canAct) showActionScreen(view, 'detox');
      else showWaiting(view);
      break;
    case 'night-info':
      showNightInfo(view);
      break;
    case 'game-over':
      showGameOver(view);
      break;
  }
}

function showRoleReveal(view) {
  showScreen('role-reveal');
  const role = getRoleInfo(view.myRole);
  $('#role-icon').textContent = role.icon;
  $('#role-name').textContent = role.name;
  $('#role-side').textContent = role.sideLabel;
  $('#role-side').className = 'role-side ' + role.side;
  $('#role-desc').textContent = role.desc;

  const extra = $('#p2p-extra-info');
  let extraHtml = '';
  if (view.unusedRole) extraHtml += `<p>📋 未入局身份：<strong>${view.unusedRole.name}</strong></p>`;
  if (view.merlinInfo) extraHtml += `<p>👁️ 投毒者是：<strong>${view.merlinInfo.poisonerName}</strong></p>`;
  if (view.loyalistInfo) extraHtml += `<p>👑 梅林是：<strong>${view.loyalistInfo.merlinName}</strong></p>`;

  if (extraHtml) {
    extra.innerHTML = extraHtml;
    extra.classList.remove('hidden');
  } else {
    extra.classList.add('hidden');
  }
}

function showWaiting(view) {
  showScreen('night-waiting');
  $('#round-num-waiting').textContent = view.round;
  const reason = view.phase === 'night-poisoner' ? '等待投毒者行动…' :
                 view.phase === 'night-mage' ? '等待法师行动…' : '等待中…';
  $('#waiting-reason').textContent = reason;
}

function showActionScreen(view, actionType) {
  showScreen('night-action');
  $('#round-num-action').textContent = view.round;

  if (actionType === 'poison') {
    $('#action-title').textContent = '☠️ 投毒者行动';
    $('#action-desc').textContent = '选择一名玩家投毒（中毒者白天被迫破坏）';
    $('#action-hint').textContent = '';
  } else {
    $('#action-title').textContent = '🧙 法师行动';
    $('#action-desc').textContent = '若认为某人被投毒，对其施法解毒';
    $('#action-hint').textContent = '⚠️ 若对方未中毒，毒药将反噬';
  }

  const targetsDiv = $('#action-targets');
  targetsDiv.innerHTML = '';

  view.targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.textContent = '👤 ' + t.name;
    btn.addEventListener('click', () => {
      if (isHost) {
        hostSelfAction(actionType, t.name);
        showScreen('night-waiting');
        $('#waiting-reason').textContent = '等待其他玩家…';
      } else if (hostDC) {
        hostDC.send(JSON.stringify({
          type: 'night-action',
          name: myName,
          actionType: actionType,
          targetId: t.name
        }));
        showScreen('night-waiting');
        $('#waiting-reason').textContent = '等待其他玩家…';
      }
    });
    targetsDiv.appendChild(btn);
  });

  // Skip button
  const skipBtn = $('#btn-action-skip');
  skipBtn.onclick = () => {
    if (isHost) {
      hostSelfAction(actionType, null);
      showScreen('night-waiting');
      $('#waiting-reason').textContent = '等待其他玩家…';
    } else if (hostDC) {
      hostDC.send(JSON.stringify({
        type: 'night-action',
        name: myName,
        actionType: actionType,
        targetId: null
      }));
      showScreen('night-waiting');
      $('#waiting-reason').textContent = '等待其他玩家…';
    }
  };
}

function showNightInfo(view) {
  showScreen('night-info');
  $('#round-num-info').textContent = view.round;

  const role = getRoleInfo(view.myRole);
  let html = '';

  if (view.myRole === 'poisoner') {
    html = `<p>☠️ 你是<strong>${role.name}</strong></p><p>你的行动已完成。</p>`;
  } else if (view.myRole === 'mage') {
    html = `<p>🧙 你是<strong>${role.name}</strong></p><p>你的法术已施放。</p>`;
  } else if (view.merlinInfo) {
    html = `<p>👁️ 你是<strong>${role.name}</strong></p><p>投毒者是：<strong>${view.merlinInfo.poisonerName}</strong></p>`;
  } else if (view.loyalistInfo) {
    html = `<p>👑 你是<strong>${role.name}</strong></p><p>梅林是：<strong>${view.loyalistInfo.merlinName}</strong></p>`;
  } else if (view.sageInfo !== undefined) {
    html = `<p>📊 你是<strong>${role.name}</strong></p><p>本轮中毒人数：<strong>${view.sageInfo.poisonCount}</strong> 人</p>`;
  } else {
    html = `<p>你是<strong>${role.name}</strong></p><p>等待白天…</p>`;
  }

  $('#night-info-content').innerHTML = html;
}

function showGameOver(view) {
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
    detail = view.players.map(p => {
      const r = getRoleInfo(p.role);
      return `${p.name}: ${r.icon} ${r.name}`;
    }).join('\n');
  }
  $('#game-over-detail').textContent = detail;
}

// ============ 房主大厅 UI ============
function setupHostLobby() {
  showScreen('host-lobby');
  updateHostSlotsUI();
}

function updateHostSlotsUI() {
  const slotsDiv = $('#host-slots');
  let html = '';
  for (let i = 0; i < 3; i++) {
    const conn = hostConnections[i];
    const isConn = conn && conn.connected;
    const isWait = conn && !conn.connected;
    html += `<div class="slot-card ${isConn ? 'connected' : (isWait ? 'connecting' : '')}">
      <div class="slot-status">${isConn ? '✅ 已连接' : (isWait ? '⏳ 等待回复…' : '⬜ 空位 #' + (i+1))}</div>
      <div class="slot-name">${conn?.playerName || '---'}</div>`;

    if (!conn) {
      html += `<button class="btn btn-outline slot-code-btn btn-sm" data-slot="${i}">📋 复制连接码给朋友</button>`;
    } else if (!isConn) {
      html += `<div class="slot-paste-area">
        <textarea placeholder="粘贴朋友的回复码..." data-slot="${i}" rows="2"></textarea>
        <button class="btn btn-primary btn-sm" data-slot="${i}" data-action="paste">📥 确认回复码</button>
      </div>`;
    }
    html += `</div>`;
  }
  slotsDiv.innerHTML = html;

  // 绑定 "复制连接码" 按钮
  slotsDiv.querySelectorAll('.slot-code-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.slot);
      btn.disabled = true;
      btn.textContent = '⏳ 生成中…';
      try {
        const offerStr = await hostCreateOffer(idx);
        await navigator.clipboard.writeText(offerStr);
        showToast('连接码已复制！发送给朋友');
        updateHostSlotsUI();
      } catch (e) {
        showToast('生成失败: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '📋 复制连接码给朋友';
      }
    });
  });

  // 绑定 "确认回复码" 按钮
  slotsDiv.querySelectorAll('[data-action="paste"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.slot);
      const textarea = slotsDiv.querySelector(`textarea[data-slot="${idx}"]`);
      const answerStr = textarea.value.trim();
      if (!answerStr) { showToast('请先粘贴回复码', 'error'); return; }
      btn.disabled = true;
      btn.textContent = '⏳ 连接中…';
      const ok = await hostReceiveAnswer(idx, answerStr);
      if (!ok) {
        showToast('回复码无效', 'error');
        btn.disabled = false;
        btn.textContent = '📥 确认回复码';
      }
      // ondatachannel -> onopen will update UI
    });
  });

  // 更新开始按钮
  const allConnected = hostConnections.filter(c => c && c.connected).length === 3;
  $('#btn-start-game').disabled = !allConnected;
}

// ============ 事件绑定 ============

// 创建房间
$('#btn-create').addEventListener('click', () => {
  myName = $('#input-player-name').value.trim() || '房主';
  isHost = true;
  hostConnections = [];
  setupHostLobby();
});

// 加入房间 — 显示粘贴区
$('#btn-join').addEventListener('click', () => {
  $('#join-section').classList.remove('hidden');
});

$('#btn-join-cancel').addEventListener('click', () => {
  $('#join-section').classList.add('hidden');
});

// 加入房间 — 连接
$('#btn-join-submit').addEventListener('click', async () => {
  myName = $('#input-player-name').value.trim() || '玩家';
  const offerStr = $('#input-join-code').value.trim();
  if (!offerStr) { showToast('请粘贴房主的连接码', 'error'); return; }

  $('#btn-join-submit').disabled = true;
  $('#btn-join-submit').textContent = '⏳ 连接中…';

  try {
    const answerStr = await clientConnect(offerStr);
    $('#my-answer-section').classList.remove('hidden');
    $('#output-answer').value = answerStr;
    showToast('连接成功！请复制回复码发给房主');
  } catch (e) {
    showToast('连接失败: ' + e.message, 'error');
    $('#btn-join-submit').disabled = false;
    $('#btn-join-submit').textContent = '🔗 连接';
  }
});

// 复制回复码
$('#btn-copy-answer').addEventListener('click', async () => {
  const answer = $('#output-answer').value;
  try {
    await navigator.clipboard.writeText(answer);
    showToast('回复码已复制！发回给房主');
  } catch {
    // Fallback
    $('#output-answer').select();
    showToast('请手动复制上面的文本');
  }
});

// 开始游戏（房主）
$('#btn-start-game').addEventListener('click', () => {
  const playerNames = [];
  hostConnections.forEach(c => {
    if (c && c.connected) playerNames.push(c.playerName);
  });
  if (playerNames.length !== 3) { showToast('需要3名玩家连接', 'error'); return; }

  gameState = createGameState(playerNames);

  // 给每个客户端发送身份
  gameState.players.forEach(p => {
    const view = getClientView(gameState, p.name);
    if (p.name === myName) {
      handlePhaseChange(view);
    } else {
      const conn = hostConnections.find(c => c && c.playerName === p.name);
      if (conn) hostSendTo(conn.index, { type: 'phase-change', view });
    }
  });
});

// 确认身份
$('#btn-confirm-role').addEventListener('click', () => {
  if (isHost) {
    hostSelfConfirm();
    showScreen('night-waiting');
    $('#waiting-reason').textContent = '等待所有玩家确认…';
  } else if (hostDC) {
    hostDC.send(JSON.stringify({ type: 'confirm-phase', name: myName }));
    showScreen('night-waiting');
    $('#waiting-reason').textContent = '等待所有玩家确认…';
  }
});

// 确认夜晚信息
$('#btn-confirm-info').addEventListener('click', () => {
  if (isHost) {
    hostSelfConfirm();
  } else if (hostDC) {
    hostDC.send(JSON.stringify({ type: 'confirm-phase', name: myName }));
  }
  showScreen('night-waiting');
  $('#waiting-reason').textContent = '等待其他玩家…';
});

// 返回按钮
$('#btn-host-back').addEventListener('click', () => {
  hostConnections.forEach(c => { if (c) { c.pc.close(); } });
  hostConnections = [];
  isHost = false;
  gameState = null;
  showScreen('home');
});

// 再来一局
$('#btn-new-game').addEventListener('click', () => {
  if (isHost) {
    hostConnections.forEach(c => { if (c) c.pc.close(); });
    hostConnections = [];
    gameState = null;
    showScreen('home');
  } else {
    if (hostPC) hostPC.close();
    hostPC = null;
    hostDC = null;
    showScreen('home');
  }
});
