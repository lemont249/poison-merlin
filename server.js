const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ========== 常量 ==========
const ALL_ROLES = {
  merlin:    { name: '梅林',   side: 'good', desc: '免疫投毒和解毒负面效果，知道投毒者是谁' },
  mage:      { name: '法师',   side: 'good', desc: '夜晚可对一名玩家施法解毒；若对方未中毒则反而中毒' },
  sage:      { name: '知者',   side: 'good', desc: '知道本轮白天中毒的总人数' },
  loyalist:  { name: '忠臣',   side: 'good', desc: '知道谁是梅林' },
  poisoner:  { name: '投毒者', side: 'evil', desc: '夜晚可投毒一人，中毒者白天破坏；知道一张未入局的好人身份' },
};

const GOOD_ROLES = ['merlin', 'mage', 'sage', 'loyalist'];
const MAX_ROUNDS = 5;

// ========== 内存存储 ==========
const games = new Map(); // roomCode -> game

function createGame(roomCode) {
  return {
    roomCode,
    players: [],           // { id, name, role, isHost }
    unusedRole: null,      // 未入局的好人身份
    phase: 'lobby',        // lobby | role-reveal | night-poisoner | night-mage | night-info | game-over
    round: 1,
    poisonerTarget: null,  // 投毒者目标 playerId
    mageTarget: null,      // 法师目标 playerId
    merlinPoisonCount: 0,  // 投毒者选中梅林的累计次数
    poisonList: [],        // 本轮中毒的 playerId 列表
    gameOver: false,
    winner: null,
    winReason: null,
    confirmedPlayers: [],  // 已确认当前阶段的玩家
  };
}

// ========== 辅助函数 ==========
function generateRoomCode() {
  const digits = '0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += digits[Math.floor(Math.random() * 10)];
  }
  return code;
}

function assignRoles() {
  // 梅林必入局
  const inPlay = ['merlin'];
  // 从剩余3个好角色中随机选2个入局
  const otherGood = ['mage', 'sage', 'loyalist'];
  shuffle(otherGood);
  inPlay.push(otherGood[0], otherGood[1]);
  const unused = otherGood[2]; // 未入局的好人身份
  // 投毒者入局
  inPlay.push('poisoner');
  shuffle(inPlay);
  return { inPlay, unused };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getPlayerView(game, playerId) {
  const player = game.players.find(p => p.id === playerId);
  if (!player) return null;

  const view = {
    myRole: player.role,
    myName: player.name,
    phase: game.phase,
    round: game.round,
    maxRounds: MAX_ROUNDS,
    gameOver: game.gameOver,
    winner: game.winner,
    winReason: game.winReason,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      // 不暴露角色给其他玩家
      role: p.id === playerId ? p.role : undefined,
    })),
  };

  // 投毒者额外看到未入局身份
  if (player.role === 'poisoner' && game.unusedRole) {
    view.unusedRole = ALL_ROLES[game.unusedRole];
  }

  // 梅林看到投毒者是谁
  if (player.role === 'merlin') {
    const poisoner = game.players.find(p => p.role === 'poisoner');
    if (poisoner) {
      view.merlinInfo = { poisonerName: poisoner.name };
    }
  }

  // 知者看到本轮中毒人数
  if (player.role === 'sage' && game.phase === 'night-info') {
    view.sageInfo = { poisonCount: game.poisonList.length };
  }

  // 忠臣看到梅林是谁
  if (player.role === 'loyalist') {
    const merlin = game.players.find(p => p.role === 'merlin');
    if (merlin) {
      view.loyalistInfo = { merlinName: merlin.name };
    }
  }

  // 当前阶段可行动信息
  if (game.phase === 'night-poisoner' && player.role === 'poisoner') {
    view.canAct = true;
    view.actionType = 'poison';
    view.targets = game.players.filter(p => p.id !== playerId).map(p => ({ id: p.id, name: p.name }));
  }

  if (game.phase === 'night-mage' && player.role === 'mage') {
    view.canAct = true;
    view.actionType = 'detox';
    view.targets = game.players.filter(p => p.id !== playerId).map(p => ({ id: p.id, name: p.name }));
  }

  // 待确认列表
  view.needConfirm = !game.confirmedPlayers.includes(playerId);

  return view;
}

function resolveNight(game) {
  // 重置中毒列表
  game.poisonList = [];

  const merlin = game.players.find(p => p.role === 'merlin');
  const poisonTarget = game.players.find(p => p.id === game.poisonerTarget);
  const mageTarget = game.players.find(p => p.id === game.mageTarget);

  // 1. 处理投毒（梅林免疫）
  if (poisonTarget && poisonTarget.role !== 'merlin') {
    game.poisonList.push(poisonTarget.id);
  }

  // 2. 处理解毒
  if (mageTarget) {
    const wasPoisoned = game.poisonList.includes(mageTarget.id);
    if (wasPoisoned) {
      // 解毒成功 - 从中毒列表移除
      game.poisonList = game.poisonList.filter(id => id !== mageTarget.id);
    } else if (mageTarget.role !== 'merlin') {
      // 目标未中毒 → 反噬中毒（梅林免疫反噬）
      game.poisonList.push(mageTarget.id);
    }
    // 梅林被法师选中的情况：既未中毒也不反噬，无事发生
  }

  // 3. 检查投毒者是否选择了梅林（累计计数，梅林免疫但计次）
  if (game.poisonerTarget && merlin && game.poisonerTarget === merlin.id) {
    game.merlinPoisonCount++;
    if (game.merlinPoisonCount >= 3) {
      game.gameOver = true;
      game.winner = 'evil';
      game.winReason = '投毒者累计三次选中梅林，坏人直接获胜！';
      game.phase = 'game-over';
      return;
    }
  }

  game.phase = 'night-info';
}

function advanceRound(game) {
  game.round++;
  if (game.round > MAX_ROUNDS) {
    game.gameOver = true;
    game.winner = 'good';
    game.winReason = '五轮任务结束，进入处决阶段（线下进行）';
    game.phase = 'game-over';
  } else {
    game.phase = 'night-poisoner';
    game.poisonerTarget = null;
    game.mageTarget = null;
    game.poisonList = [];
    game.confirmedPlayers = [];
  }
}

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // --- 创建房间 ---
  socket.on('create-room', ({ playerName }, callback) => {
    let roomCode = generateRoomCode();
    // 避免重复房间号
    while (games.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const game = createGame(roomCode);
    const player = {
      id: socket.id,
      name: playerName || '房主',
      role: null,
      isHost: true,
    };
    game.players.push(player);
    games.set(roomCode, game);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = socket.id;

    console.log(`[房间] ${roomCode} 创建，房主: ${player.name}`);
    callback({ success: true, roomCode, players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })) });
    io.to(roomCode).emit('room-update', { roomCode, players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })) });
  });

  // --- 加入房间（同时支持重连） ---
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    const game = games.get(roomCode);
    if (!game) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    // 检查是否是重连（名字匹配已有玩家）
    const existingPlayer = game.players.find(p => p.name === playerName);
    if (existingPlayer) {
      // 重连流程
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;
      socket.data.roomCode = roomCode;
      socket.data.playerId = socket.id;
      socket.join(roomCode);

      // 更新 confirm 列表中可能存在的旧 id
      const idx = game.confirmedPlayers.indexOf(oldId);
      if (idx >= 0) game.confirmedPlayers[idx] = socket.id;

      console.log(`[重连] ${roomCode} ${playerName} 重新加入`);
      const view = getPlayerView(game, socket.id);
      callback({ success: true, rejoined: true, roomCode, view,
        players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })) });
      io.to(socket.id).emit('phase-change', view);
      io.to(roomCode).emit('room-update', {
        roomCode,
        players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost }))
      });
      return;
    }

    // 新玩家加入（仅限大厅阶段）
    if (game.players.length >= 4) {
      callback({ success: false, error: '房间已满（4人）' });
      return;
    }
    if (game.phase !== 'lobby') {
      callback({ success: false, error: '游戏已开始，无法加入新玩家' });
      return;
    }
    // 检查重名
    if (game.players.some(p => p.name === playerName)) {
      callback({ success: false, error: '名字已被占用，请换一个' });
      return;
    }

    const player = {
      id: socket.id,
      name: playerName || '玩家',
      role: null,
      isHost: false,
    };
    game.players.push(player);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = socket.id;

    console.log(`[房间] ${roomCode} ${player.name} 加入`);
    callback({ success: true, rejoined: false, roomCode,
      players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })) });
    io.to(roomCode).emit('room-update', {
      roomCode,
      players: game.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost }))
    });
  });

  // --- 开始游戏 ---
  socket.on('start-game', ({}, callback) => {
    const game = games.get(socket.data.roomCode);
    if (!game) {
      callback({ success: false, error: '游戏不存在' });
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      callback({ success: false, error: '只有房主可以开始游戏' });
      return;
    }
    if (game.players.length !== 4) {
      callback({ success: false, error: `需要4名玩家，当前${game.players.length}人` });
      return;
    }

    // 分配身份
    const { inPlay, unused } = assignRoles();
    game.players.forEach((p, i) => {
      p.role = inPlay[i];
    });
    game.unusedRole = unused;
    game.phase = 'role-reveal';
    game.confirmedPlayers = [];

    console.log(`[游戏] ${game.roomCode} 开始，未入局: ${ALL_ROLES[unused].name}`);

    // 给每个玩家发送各自的视角
    game.players.forEach(p => {
      const view = getPlayerView(game, p.id);
      io.to(p.id).emit('role-assigned', view);
      io.to(p.id).emit('phase-change', view);
    });

    callback({ success: true });
  });

  // --- 确认阶段 ---
  socket.on('confirm-phase', ({}, callback) => {
    const game = games.get(socket.data.roomCode);
    if (!game) return;

    const playerId = socket.id;
    if (!game.confirmedPlayers.includes(playerId)) {
      game.confirmedPlayers.push(playerId);
    }

    callback({ success: true });

    // 检查是否所有玩家都已确认
    const allConfirmed = game.players.every(p => game.confirmedPlayers.includes(p.id));

    if (allConfirmed && game.phase === 'role-reveal') {
      // 进入第一轮夜晚
      game.phase = 'night-poisoner';
      game.confirmedPlayers = [];
      game.players.forEach(p => {
        const view = getPlayerView(game, p.id);
        io.to(p.id).emit('phase-change', view);
      });
    } else if (allConfirmed && game.phase === 'night-info') {
      // 进入下一轮
      advanceRound(game);
      game.players.forEach(p => {
        const view = getPlayerView(game, p.id);
        io.to(p.id).emit('phase-change', view);
      });
    }
  });

  // --- 夜晚行动 ---
  socket.on('night-action', ({ targetId, action }, callback) => {
    const game = games.get(socket.data.roomCode);
    if (!game) {
      callback({ success: false, error: '游戏不存在' });
      return;
    }

    const player = game.players.find(p => p.id === socket.id);

    if (game.phase === 'night-poisoner' && player.role === 'poisoner') {
      if (action === 'skip') {
        game.poisonerTarget = null;
      } else if (targetId) {
        game.poisonerTarget = targetId;
      }
      game.confirmedPlayers.push(socket.id);

      // 检查是否进入法师阶段
      // 实际上只有投毒者一个人行动，所以直接进入法师阶段
      game.phase = 'night-mage';
      game.players.forEach(p => {
        const view = getPlayerView(game, p.id);
        io.to(p.id).emit('phase-change', view);
      });
    } else if (game.phase === 'night-mage' && player.role === 'mage') {
      if (action === 'skip') {
        game.mageTarget = null;
      } else if (targetId) {
        game.mageTarget = targetId;
      }

      // 结算夜晚
      resolveNight(game);
      game.confirmedPlayers = [];

      game.players.forEach(p => {
        const view = getPlayerView(game, p.id);
        io.to(p.id).emit('phase-change', view);
      });
    } else {
      callback({ success: false, error: '现在不是你行动的时机' });
      return;
    }

    callback({ success: true });
  });

  // --- 重连 ---
  socket.on('rejoin', ({ roomCode, playerName }, callback) => {
    const game = games.get(roomCode);
    if (!game) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    const player = game.players.find(p => p.name === playerName);
    if (!player) {
      callback({ success: false, error: '玩家不在房间中' });
      return;
    }

    // 更新 socket id
    const oldId = player.id;
    player.id = socket.id;
    socket.data.roomCode = roomCode;
    socket.data.playerId = socket.id;
    socket.join(roomCode);

    // 更新 confirm 列表中的旧 id
    const idx = game.confirmedPlayers.indexOf(oldId);
    if (idx >= 0) game.confirmedPlayers[idx] = socket.id;

    const view = getPlayerView(game, socket.id);
    callback({ success: true, view });
    io.to(socket.id).emit('phase-change', view);
  });

  // --- 断开连接 ---
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);
    const game = games.get(socket.data.roomCode);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (player) {
      io.to(game.roomCode).emit('player-disconnected', { playerName: player.name });
      console.log(`[游戏] ${game.roomCode} ${player.name} 断开`);
    }
  });
});

// ========== 启动服务器 ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 桌游服务器已启动: http://0.0.0.0:${PORT}`);
  console.log(`   局域网内其他设备可通过你的IP访问`);
});
