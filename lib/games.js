const crypto = require('crypto');
const state  = require('./state');
const { broadcastToDevice } = require('./broadcast');

// ─── Chess engine ─────────────────────────────────────────────────────────────

function makeInitBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { type: back[c], color: 'b' };
    b[1][c] = { type: 'P', color: 'b' };
    b[6][c] = { type: 'P', color: 'w' };
    b[7][c] = { type: back[c], color: 'w' };
  }
  return b;
}

function cloneBoard(board) {
  return board.map(row => row.map(p => p ? { ...p } : null));
}

// Squares a piece can reach ignoring check — no castling, no en passant.
function pseudoMoves(board, r, c) {
  const p = board[r][c];
  if (!p) return [];
  const { type, color } = p;
  const enemy = color === 'w' ? 'b' : 'w';
  const m = [];

  const slide = (dr, dc) => {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const sq = board[nr][nc];
      if (sq) { if (sq.color === enemy) m.push([nr, nc]); break; }
      m.push([nr, nc]);
      nr += dr; nc += dc;
    }
  };

  if (type === 'P') {
    const d = color === 'w' ? -1 : 1;
    const startR = color === 'w' ? 6 : 1;
    if (r + d >= 0 && r + d < 8 && !board[r + d][c]) {
      m.push([r + d, c]);
      if (r === startR && !board[r + 2 * d][c]) m.push([r + 2 * d, c]);
    }
    for (const dc of [-1, 1]) {
      const nc = c + dc;
      if (nc >= 0 && nc < 8 && r + d >= 0 && r + d < 8 && board[r + d][nc]?.color === enemy)
        m.push([r + d, nc]);
    }
    return m;
  }
  if (type === 'R') { slide(1,0);slide(-1,0);slide(0,1);slide(0,-1); return m; }
  if (type === 'B') { slide(1,1);slide(1,-1);slide(-1,1);slide(-1,-1); return m; }
  if (type === 'Q') { slide(1,0);slide(-1,0);slide(0,1);slide(0,-1);slide(1,1);slide(1,-1);slide(-1,1);slide(-1,-1); return m; }
  if (type === 'N') {
    for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r+dr, nc = c+dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc]?.color !== color) m.push([nr,nc]);
    }
    return m;
  }
  if (type === 'K') {
    for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
      const nr = r+dr, nc = c+dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc]?.color !== color) m.push([nr,nc]);
    }
    return m;
  }
  return m;
}

function isAttackedBy(board, r, c, byColor) {
  const opp = byColor;
  // Knight
  for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const p = board[r+dr]?.[c+dc];
    if (p?.color === opp && p.type === 'N') return true;
  }
  // Pawn (white pawns attack from below: they're at row+1; black attack from above: row-1)
  const pd = opp === 'w' ? 1 : -1;
  for (const dc of [-1,1]) {
    const p = board[r+pd]?.[c+dc];
    if (p?.color === opp && p.type === 'P') return true;
  }
  // King
  for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const p = board[r+dr]?.[c+dc];
    if (p?.color === opp && p.type === 'K') return true;
  }
  // Rook/Queen (rank & file)
  for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    let nr = r+dr, nc = c+dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr][nc];
      if (p) { if (p.color === opp && (p.type === 'R' || p.type === 'Q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  // Bishop/Queen (diagonal)
  for (const [dr,dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let nr = r+dr, nc = c+dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr][nc];
      if (p) { if (p.color === opp && (p.type === 'B' || p.type === 'Q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  return false;
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c]?.type === 'K' && board[r][c]?.color === color) return [r, c];
  return [0, 0];
}

function isInCheck(board, color) {
  const [kr, kc] = findKing(board, color);
  return isAttackedBy(board, kr, kc, color === 'w' ? 'b' : 'w');
}

function applyRaw(board, fr, fc, tr, tc, promo, ep) {
  const nb = cloneBoard(board);
  const piece = nb[fr][fc];
  // En passant pawn capture
  if (piece.type === 'P' && fc !== tc && !nb[tr][tc] && ep && tr === ep.row && tc === ep.col) {
    nb[fr][tc] = null;
  }
  nb[tr][tc] = promo ? { type: promo, color: piece.color } : { ...piece };
  nb[fr][fc] = null;
  return nb;
}

function getLegalMoves(board, fr, fc, ep, castling) {
  const piece = board[fr][fc];
  if (!piece) return [];
  const { color } = piece;
  const opp = color === 'w' ? 'b' : 'w';
  const legal = [];

  // En passant
  if (piece.type === 'P' && ep) {
    const d = color === 'w' ? -1 : 1;
    if (fr + d === ep.row && Math.abs(fc - ep.col) === 1) {
      const nb = applyRaw(board, fr, fc, ep.row, ep.col, null, ep);
      if (!isInCheck(nb, color)) legal.push([ep.row, ep.col]);
    }
  }

  for (const [tr, tc] of pseudoMoves(board, fr, fc)) {
    const nb = applyRaw(board, fr, fc, tr, tc, null, null);
    if (!isInCheck(nb, color)) legal.push([tr, tc]);
  }

  // Castling
  if (piece.type === 'K') {
    const row = color === 'w' ? 7 : 0;
    if (fr === row && fc === 4 && !isAttackedBy(board, row, 4, opp)) {
      if ((color === 'w' ? castling.wk : castling.bk) &&
          !board[row][5] && !board[row][6] &&
          !isAttackedBy(board, row, 5, opp) && !isAttackedBy(board, row, 6, opp))
        legal.push([row, 6]);
      if ((color === 'w' ? castling.wq : castling.bq) &&
          !board[row][3] && !board[row][2] && !board[row][1] &&
          !isAttackedBy(board, row, 3, opp) && !isAttackedBy(board, row, 2, opp))
        legal.push([row, 2]);
    }
  }

  return legal;
}

function getAllLegalMoves(board, color, ep, castling) {
  const all = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c]?.color === color)
        for (const [tr, tc] of getLegalMoves(board, r, c, ep, castling))
          all.push([r, c, tr, tc]);
  return all;
}

function applyChessMove(game, deviceId, from, to, promotion) {
  if (game.status !== 'active') return { error: 'game not active' };
  if (game.players[game.turn] !== deviceId) return { error: 'not your turn' };

  const { board, enPassant, castling } = game.state;
  const color = game.turn === 0 ? 'w' : 'b';
  const opp   = color === 'w' ? 'b' : 'w';
  const [fr, fc] = from;
  const [tr, tc] = to;
  const piece = board[fr]?.[fc];
  if (!piece || piece.color !== color) return { error: 'invalid piece' };

  const legal = getLegalMoves(board, fr, fc, enPassant, castling);
  if (!legal.some(([lr, lc]) => lr === tr && lc === tc)) return { error: 'illegal move' };

  const promo = (piece.type === 'P' && (tr === 0 || tr === 7))
    ? (['Q','R','B','N'].includes(promotion) ? promotion : 'Q')
    : null;

  let nb = applyRaw(board, fr, fc, tr, tc, promo, enPassant);

  // Castling: move the rook
  const newCastling = { ...castling };
  if (piece.type === 'K') {
    const row = color === 'w' ? 7 : 0;
    if (fc === 4 && tc === 6) { nb[row][5] = { ...nb[row][7] }; nb[row][7] = null; }
    if (fc === 4 && tc === 2) { nb[row][3] = { ...nb[row][0] }; nb[row][0] = null; }
    if (color === 'w') { newCastling.wk = false; newCastling.wq = false; }
    else               { newCastling.bk = false; newCastling.bq = false; }
  }
  if (piece.type === 'R') {
    if (color === 'w') { if (fc === 7) newCastling.wk = false; if (fc === 0) newCastling.wq = false; }
    else               { if (fc === 7) newCastling.bk = false; if (fc === 0) newCastling.bq = false; }
  }
  // Rook captured at home square also loses castling right
  const cap = board[tr]?.[tc];
  if (cap?.type === 'R') {
    if (tr === 7 && tc === 7) newCastling.wk = false;
    if (tr === 7 && tc === 0) newCastling.wq = false;
    if (tr === 0 && tc === 7) newCastling.bk = false;
    if (tr === 0 && tc === 0) newCastling.bq = false;
  }

  const newEP = (piece.type === 'P' && Math.abs(fr - tr) === 2)
    ? { row: (fr + tr) / 2, col: fc }
    : null;

  const nextTurn  = 1 - game.turn;
  const inCheck   = isInCheck(nb, opp);
  const allMoves  = getAllLegalMoves(nb, opp, newEP, newCastling);

  let status = 'active', winner = null;
  if (allMoves.length === 0) {
    status = 'done';
    winner = inCheck ? game.turn : 'draw';
  }

  game.state  = { board: nb, enPassant: newEP, castling: newCastling, turn: nextTurn, inCheck: inCheck ? opp : null };
  game.turn   = nextTurn;
  game.status = status;
  game.winner = winner;
  return { ok: true };
}

// ─── Connect Four ─────────────────────────────────────────────────────────────

function applyC4Move(game, deviceId, col) {
  if (game.status !== 'active') return { error: 'game not active' };
  if (game.players[game.turn] !== deviceId) return { error: 'not your turn' };
  if (col < 0 || col > 6) return { error: 'invalid column' };

  const { board } = game.state;
  let row = -1;
  for (let r = 5; r >= 0; r--) { if (!board[r][col]) { row = r; break; } }
  if (row === -1) return { error: 'column full' };

  board[row][col] = game.turn + 1;
  game.state.lastMove = { row, col };

  const winCells = checkC4Win(board, row, col, game.turn + 1);
  if (winCells) {
    game.state.winCells = winCells;
    game.status = 'done';
    game.winner = game.turn;
    return { ok: true };
  }

  if (board[0].every(v => v !== 0)) { game.status = 'done'; game.winner = 'draw'; }
  else game.turn = 1 - game.turn;
  return { ok: true };
}

function checkC4Win(board, row, col, player) {
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    const cells = [[row, col]];
    for (let i = 1; i < 4; i++) {
      const r = row + dr*i, c = col + dc*i;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r][c] !== player) break;
      cells.push([r, c]);
    }
    for (let i = 1; i < 4; i++) {
      const r = row - dr*i, c = col - dc*i;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r][c] !== player) break;
      cells.push([r, c]);
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

// ─── Room management ──────────────────────────────────────────────────────────

function makeGameState(type) {
  if (type === 'chess') {
    return { board: makeInitBoard(), enPassant: null, castling: { wk:true, wq:true, bk:true, bq:true }, turn: 0, inCheck: null };
  }
  if (type === 'connect4') {
    return { board: Array.from({ length: 6 }, () => Array(7).fill(0)), lastMove: null, winCells: null };
  }
  throw new Error('unknown game type: ' + type);
}

function createGame(type, deviceId) {
  const id = crypto.randomBytes(3).toString('hex'); // 6-char code
  const game = { id, type, players: [deviceId], turn: 0, status: 'waiting', winner: null, createdAt: Date.now(), state: makeGameState(type) };
  state.games.set(id, game);
  return game;
}

function serializeGame(game) {
  return { id: game.id, type: game.type, players: game.players, turn: game.turn, status: game.status, winner: game.winner, state: game.state };
}

function pushGameState(game) {
  const payload = { type: 'game:state', game: serializeGame(game) };
  for (const pid of game.players) broadcastToDevice(pid, payload);
}

// ─── WebSocket handler ────────────────────────────────────────────────────────

function handleGameMessage(ws, msg, deviceId) {
  if (!deviceId) return;

  if (msg.type === 'game:create') {
    if (!['chess','connect4'].includes(msg.gameType)) return;
    const game = createGame(msg.gameType, deviceId);
    broadcastToDevice(deviceId, { type: 'game:created', game: serializeGame(game) });
    return;
  }

  if (msg.type === 'game:join') {
    const game = state.games.get(msg.gameId);
    if (!game) { broadcastToDevice(deviceId, { type: 'game:error', gameId: msg.gameId, error: 'Room not found' }); return; }
    if (game.players.includes(deviceId)) {
      broadcastToDevice(deviceId, { type: 'game:joined', game: serializeGame(game) }); return;
    }
    if (game.players.length >= 2) { broadcastToDevice(deviceId, { type: 'game:error', gameId: msg.gameId, error: 'Room is full' }); return; }
    game.players.push(deviceId);
    game.status = 'active';
    pushGameState(game);
    return;
  }

  if (msg.type === 'game:move') {
    const game = state.games.get(msg.gameId);
    if (!game || !game.players.includes(deviceId)) return;
    let result;
    if (game.type === 'chess')    result = applyChessMove(game, deviceId, msg.from, msg.to, msg.promotion);
    if (game.type === 'connect4') result = applyC4Move(game, deviceId, msg.col);
    if (result?.error) { broadcastToDevice(deviceId, { type: 'game:error', gameId: msg.gameId, error: result.error }); return; }
    pushGameState(game);
    return;
  }

  if (msg.type === 'game:resign') {
    const game = state.games.get(msg.gameId);
    if (!game) return;
    const idx = game.players.indexOf(deviceId);
    if (idx === -1 || game.status !== 'active') return;
    game.status = 'done';
    game.winner = 1 - idx;
    pushGameState(game);
    return;
  }

  if (msg.type === 'game:rematch') {
    const game = state.games.get(msg.gameId);
    if (!game || !game.players.includes(deviceId) || game.status !== 'done') return;
    // Swap sides and restart
    const newGame = createGame(game.type, game.players[1]);
    if (game.players.length > 1 && game.players[0] !== game.players[1]) {
      newGame.players.push(game.players[0]);
      newGame.status = 'active';
    }
    state.games.delete(msg.gameId);
    for (const pid of game.players) broadcastToDevice(pid, { type: 'game:rematch', gameId: newGame.id, game: serializeGame(newGame) });
    return;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

module.exports = function setupGamesRoutes(app) {
  // Open lobbies (waiting for a second player)
  app.get('/api/games', (req, res) => {
    const list = [...state.games.values()]
      .filter(g => g.status === 'waiting')
      .map(g => ({ id: g.id, type: g.type, createdAt: g.createdAt }));
    res.json(list);
  });
};

module.exports.handleGameMessage = handleGameMessage;
