// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 屏幕
const screens = {
  home: $('#screen-home'),
  lobby: $('#screen-lobby'),
  roleReveal: $('#screen-role-reveal'),
  nightPoisoner: $('#screen-night-poisoner'),
  nightMage: $('#screen-night-mage'),
  nightWaiting: $('#screen-night-waiting'),
  nightInfo: $('#screen-night-info'),
  gameOver: $('#screen-game-over'),
};

// ========== 状态 ==========
let socket = null;
let myPlayerName = '';
let roomCode = '';
let currentView = null;
let selectedTarget = null;

// ========== Socket 连接 ==========
function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] 已连接', socket.id);
  });

  socket.on('disconnect', () => {
    showToast('连接已断开，请刷新页面', 'error');
  });

  // --- 房间更新 ---
  socket.on('room-update', ({ roomCode: code, players }) => {
    updateLobbyPlayers(players);
    const btnStart = $('#btn-start-game');
    const hint = $('#lobby-start-hint');
    const me = players.find(p => p.id === socket.id);

    if (me && me.isHost) {
      btnStart.disabled = players.length !== 4;
      hint.textContent = players.length === 4 ? '可以开始了！' : '仅房主可开始';
    } else {
      btnStart.disabled = true;
      hint.textContent = '等待房主开始游戏…';
    }
  });

  // --- 身份分配 ---
  socket.on('role-assigned', (view) => {
    currentView = view;
    showRoleReveal(view);
  });

  // --- 阶段变更 ---
  socket.on('phase-change', (view) => {
    currentView = view;
    handlePhaseChange(view);
  });

  // --- 玩家断开 ---
  socket.on('player-disconnected', ({ playerName }) => {
    showToast(`${playerName} 断开了连接`, 'error');
  });
}

// ========== 屏幕切换 ==========
function showScreen(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  const target = screens[screenId];
  if (target) target.classList.add('active');
}

// ========== Toast ==========
function showToast(msg, type = '') {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.className = 'toast ' + type;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ========== 首页逻辑 ==========
$('#btn-create').addEventListener('click', () => {
  const name = $('#input-player-name').value.trim() || '玩家';
  myPlayerName = name;
  socket.emit('create-room', { playerName: name }, (res) => {
    if (res.success) {
      roomCode = res.roomCode;
      updateLobbyPlayers(res.players);
      showScreen('lobby');
      $('#lobby-room-code').textContent = roomCode;
    } else {
      showToast(res.error, 'error');
    }
  });
});

$('#btn-join').addEventListener('click', () => {
  $('#join-form').classList.toggle('hidden');
  if (!$('#join-form').classList.contains('hidden')) {
    $('#input-room-code').focus();
  }
});

$('#btn-join-submit').addEventListener('click', () => {
  joinRoom();
});

$('#input-room-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

$('#btn-join-cancel').addEventListener('click', () => {
  $('#join-form').classList.add('hidden');
  $('#input-room-code').value = '';
});

function joinRoom() {
  const code = $('#input-room-code').value.trim();
  const name = $('#input-player-name').value.trim() || '玩家';

  if (!code || code.length !== 4) {
    showToast('请输入4位房间号', 'error');
    return;
  }

  myPlayerName = name;
  socket.emit('join-room', { roomCode: code, playerName: name }, (res) => {
    if (res.success) {
      roomCode = res.roomCode;
      $('#join-form').classList.add('hidden');
      $('#input-room-code').value = '';

      if (res.rejoined) {
        // 重连：直接跳转到对应阶段
        updateLobbyPlayers(res.players);
        // 重连时服务端已经推送了 phase-change，这里不需要额外操作
        showToast('已重新连接', '');
      } else {
        updateLobbyPlayers(res.players);
        showScreen('lobby');
        $('#lobby-room-code').textContent = roomCode;
      }
    } else {
      showToast(res.error, 'error');
    }
  });
}

// ========== 大厅 ==========
function updateLobbyPlayers(players) {
  const list = $('#lobby-player-list');
  list.innerHTML = players.map(p =>
    `<li>
      <span class="player-dot"></span>
      ${escapeHtml(p.name)}
      ${p.isHost ? '<span class="host-badge">房主</span>' : ''}
    </li>`
  ).join('');

  // 更新开始按钮状态
  const me = players.find(p => p.id === socket.id);
  if (me && me.isHost) {
    $('#btn-start-game').disabled = players.length !== 4;
  }
}

$('#btn-start-game').addEventListener('click', () => {
  socket.emit('start-game', {}, (res) => {
    if (!res.success) {
      showToast(res.error, 'error');
    }
  });
});

// ========== 身份揭示 ==========
function showRoleReveal(view) {
  showScreen('roleReveal');
  const role = getRoleInfo(view.myRole);
  $('#role-icon').textContent = role.icon;
  $('#role-name').textContent = role.name;
  $('#role-side').textContent = role.sideLabel;
  $('#role-side').className = 'role-side ' + role.side;
  $('#role-desc').textContent = role.desc;

  // 投毒者看到未入局身份
  if (view.unusedRole) {
    $('#unused-role-info').classList.remove('hidden');
    $('#unused-role-name').textContent = view.unusedRole.name;
  } else {
    $('#unused-role-info').classList.add('hidden');
  }

  // 梅林信息
  if (view.merlinInfo) {
    $('#merlin-info-box').classList.remove('hidden');
    $('#merlin-sees').textContent = view.merlinInfo.poisonerName;
  } else {
    $('#merlin-info-box').classList.add('hidden');
  }

  // 忠臣信息
  if (view.loyalistInfo) {
    $('#loyalist-info-box').classList.remove('hidden');
    $('#loyalist-sees').textContent = view.loyalistInfo.merlinName;
  } else {
    $('#loyalist-info-box').classList.add('hidden');
  }
}

$('#btn-confirm-role').addEventListener('click', () => {
  socket.emit('confirm-phase', {}, (res) => {
    if (res.success) {
      // 等待 phase-change 推送
      showScreen('nightWaiting');
    }
  });
});

// ========== 阶段处理 ==========
function handlePhaseChange(view) {
  switch (view.phase) {
    case 'night-poisoner':
      if (view.canAct) {
        showPoisonerScreen(view);
      } else {
        showWaitingScreen(view);
      }
      break;

    case 'night-mage':
      if (view.canAct) {
        showMageScreen(view);
      } else {
        showWaitingScreen(view);
      }
      break;

    case 'night-info':
      showNightInfo(view);
      break;

    case 'game-over':
      showGameOver(view);
      break;

    default:
      break;
  }
}

// ========== 等待画面 ==========
function showWaitingScreen(view) {
  showScreen('nightWaiting');
  $('#round-num-waiting').textContent = view.round;
}

// ========== 投毒者画面 ==========
function showPoisonerScreen(view) {
  showScreen('nightPoisoner');
  $('#round-num-poisoner').textContent = view.round;
  selectedTarget = null;

  const targetsDiv = $('#poisoner-targets');
  targetsDiv.innerHTML = view.targets.map(t =>
    `<button class="target-btn" data-id="${t.id}">
      <span class="player-emoji">👤</span>
      ${escapeHtml(t.name)}
    </button>`
  ).join('');

  // 点击选择目标
  targetsDiv.querySelectorAll('.target-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      targetsDiv.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTarget = btn.dataset.id;

      // 选中后直接执行
      socket.emit('night-action', { targetId: selectedTarget, action: 'poison' }, (res) => {
        if (res.success) {
          showScreen('nightWaiting');
        } else {
          showToast(res.error, 'error');
        }
      });
    });
  });

  // 跳过按钮
  $('#btn-poisoner-skip').onclick = () => {
    socket.emit('night-action', { action: 'skip' }, (res) => {
      if (res.success) {
        showScreen('nightWaiting');
      } else {
        showToast(res.error, 'error');
      }
    });
  };
}

// ========== 法师画面 ==========
function showMageScreen(view) {
  showScreen('nightMage');
  $('#round-num-mage').textContent = view.round;
  selectedTarget = null;

  const targetsDiv = $('#mage-targets');
  targetsDiv.innerHTML = view.targets.map(t =>
    `<button class="target-btn" data-id="${t.id}">
      <span class="player-emoji">👤</span>
      ${escapeHtml(t.name)}
    </button>`
  ).join('');

  targetsDiv.querySelectorAll('.target-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      targetsDiv.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTarget = btn.dataset.id;

      socket.emit('night-action', { targetId: selectedTarget, action: 'detox' }, (res) => {
        if (res.success) {
          showScreen('nightWaiting');
        } else {
          showToast(res.error, 'error');
        }
      });
    });
  });

  $('#btn-mage-skip').onclick = () => {
    socket.emit('night-action', { action: 'skip' }, (res) => {
      if (res.success) {
        showScreen('nightWaiting');
      } else {
        showToast(res.error, 'error');
      }
    });
  };
}

// ========== 夜晚信息 ==========
function showNightInfo(view) {
  showScreen('nightInfo');
  $('#round-num-info').textContent = view.round;

  const role = getRoleInfo(view.myRole);
  const content = $('#night-info-content');
  const poisonCountBox = $('#poison-count-info');

  let infoHtml = '';

  // 根据角色展示信息
  if (view.merlinInfo) {
    infoHtml = `
      <p>👁️ 你是<strong>${role.name}</strong></p>
      <p>投毒者是：<strong>${view.merlinInfo.poisonerName}</strong></p>
    `;
  } else if (view.loyalistInfo) {
    infoHtml = `
      <p>👑 你是<strong>${role.name}</strong></p>
      <p>梅林是：<strong>${view.loyalistInfo.merlinName}</strong></p>
    `;
  } else if (view.sageInfo !== undefined) {
    infoHtml = `
      <p>📊 你是<strong>${role.name}</strong></p>
      <p>本轮中毒人数：<strong>${view.sageInfo.poisonCount}</strong> 人</p>
    `;
  } else if (view.myRole === 'poisoner') {
    infoHtml = `
      <p>☠️ 你是<strong>${role.name}</strong></p>
      <p>你的行动已完成，等待白天…</p>
    `;
  } else if (view.myRole === 'mage') {
    infoHtml = `
      <p>🧙 你是<strong>${role.name}</strong></p>
      <p>你的法术已施放，等待白天…</p>
    `;
  }

  content.innerHTML = infoHtml;

  // 知者额外显示中毒人数
  if (view.sageInfo !== undefined) {
    poisonCountBox.classList.remove('hidden');
    $('#poison-count').textContent = view.sageInfo.poisonCount;
  } else {
    poisonCountBox.classList.add('hidden');
  }
}

$('#btn-confirm-info').addEventListener('click', () => {
  socket.emit('confirm-phase', {}, (res) => {
    if (res.success) {
      // 等待 phase-change
    }
  });
});

// ========== 游戏结束 ==========
function showGameOver(view) {
  showScreen('gameOver');
  if (view.winner === 'evil') {
    $('#game-over-title').textContent = '💀 坏人获胜';
    $('#game-over-icon').textContent = '💀';
  } else {
    $('#game-over-title').textContent = '🏆 游戏结束';
    $('#game-over-icon').textContent = '🎉';
  }
  $('#game-over-reason').textContent = view.winReason || '';

  // 展示所有身份
  let detail = '最终身份：\n';
  if (view.players) {
    detail = view.players.map(p => {
      const r = getRoleInfo(p.role);
      return `${p.name}: ${r.icon} ${r.name}`;
    }).join('\n');
  }
  $('#game-over-detail').textContent = detail;
}

$('#btn-new-game').addEventListener('click', () => {
  location.reload();
});

// ========== 工具函数 ==========
function getRoleInfo(roleKey) {
  const roles = {
    merlin:   { name: '梅林',   icon: '🧙‍♂️', side: 'good', sideLabel: '好人阵营', desc: '免疫投毒和解毒负面效果。知道谁是投毒者。' },
    mage:     { name: '法师',   icon: '🧙',   side: 'good', sideLabel: '好人阵营', desc: '夜晚可对一人施法解毒；若对方未中毒，则反噬中毒。也可选择不行动。' },
    sage:     { name: '知者',   icon: '📊',   side: 'good', sideLabel: '好人阵营', desc: '知道本轮白天的中毒总人数。' },
    loyalist: { name: '忠臣',   icon: '🛡️',   side: 'good', sideLabel: '好人阵营', desc: '知道谁是梅林。' },
    poisoner: { name: '投毒者', icon: '☠️',   side: 'evil', sideLabel: '坏人阵营', desc: '夜晚可投毒一人，中毒者白天被迫破坏。知道一张未入局的好人身份。' },
  };
  return roles[roleKey] || { name: '未知', icon: '❓', side: '', sideLabel: '', desc: '' };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ========== 初始化 ==========
connectSocket();
