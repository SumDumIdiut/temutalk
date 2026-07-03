// Games tab — runs once at page load.
// Single-player: 2048, Minesweeper. Multiplayer: Chess, Connect Four (via WebSocket).

let curGame     = null;
let gamesReady  = false;
let mpState     = {}; // { gameId, myIdx, game }

// ── Navigation ─────────────────────────────────────────────────────────────────

function gamesInit() {
  if (gamesReady) return;
  gamesReady = true;

  document.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => openGame(card.dataset.game));
  });

  document.getElementById('game-back').addEventListener('click', () => {
    curGame = null;
    document.getElementById('game-container').style.display = 'none';
    document.getElementById('games-lobby').style.display    = '';
  });

  initChessUI();
  initC4UI();
  init2048();
  initMinesweeper();
}

function openGame(name) {
  curGame = name;
  document.getElementById('games-lobby').style.display    = 'none';
  document.getElementById('game-container').style.display = 'flex';
  document.getElementById('game-title').textContent = { '2048':'2048', minesweeper:'Minesweeper', chess:'Chess', connect4:'Connect Four' }[name] || name;

  ['2048','minesweeper','chess','connect4'].forEach(g => {
    document.getElementById('panel-' + g).style.display = g === name ? '' : 'none';
  });

  if (name === '2048')       { G2048.newGame(); }
  if (name === 'minesweeper') { GMine.init('easy'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2048
// ═══════════════════════════════════════════════════════════════════════════════

const G2048 = (() => {
  let board, score, best, moved2048 = false;

  const COLORS = {
    2:'#eee4da',4:'#ede0c8',8:'#f2b179',16:'#f59563',32:'#f67c5f',64:'#f65e3b',
    128:'#edcf72',256:'#edcc61',512:'#edc850',1024:'#edc53f',2048:'#edc22e',
  };

  function newGame() {
    board = Array.from({ length: 4 }, () => Array(4).fill(0));
    score = 0;
    best  = parseInt(localStorage.getItem('2048best') || '0');
    addTile(); addTile();
    render();
    const el = document.getElementById('g2048-over');
    if (el) el.style.display = 'none';
  }

  function addTile() {
    const empty = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!board[r][c]) empty.push([r,c]);
    if (!empty.length) return;
    const [r,c] = empty[Math.floor(Math.random() * empty.length)];
    board[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  function slideRow(row) {
    const vals = row.filter(x => x);
    let gained = 0;
    for (let i = 0; i < vals.length - 1; i++) {
      if (vals[i] === vals[i+1]) { vals[i] *= 2; gained += vals[i]; vals.splice(i+1, 1); }
    }
    while (vals.length < 4) vals.push(0);
    return { vals, gained };
  }

  function move(dir) {
    let didMove = false, gained = 0;
    const nb = board.map(r => [...r]);

    if (dir === 'left') {
      for (let r = 0; r < 4; r++) {
        const { vals, gained: g } = slideRow(nb[r]);
        if (vals.join() !== nb[r].join()) didMove = true;
        nb[r] = vals; gained += g;
      }
    } else if (dir === 'right') {
      for (let r = 0; r < 4; r++) {
        const { vals, gained: g } = slideRow([...nb[r]].reverse());
        const nr = vals.reverse();
        if (nr.join() !== nb[r].join()) didMove = true;
        nb[r] = nr; gained += g;
      }
    } else if (dir === 'up') {
      for (let c = 0; c < 4; c++) {
        const col = nb.map(r => r[c]);
        const { vals, gained: g } = slideRow(col);
        if (vals.join() !== col.join()) didMove = true;
        vals.forEach((v, r) => nb[r][c] = v); gained += g;
      }
    } else if (dir === 'down') {
      for (let c = 0; c < 4; c++) {
        const col = nb.map(r => r[c]).reverse();
        const { vals, gained: g } = slideRow(col);
        const nc = vals.reverse();
        if (nc.join() !== nb.map(r => r[c]).join()) didMove = true;
        nc.forEach((v, r) => nb[r][c] = v); gained += g;
      }
    }

    if (!didMove) return;
    board = nb;
    score += gained;
    if (score > best) { best = score; localStorage.setItem('2048best', best); }
    addTile();
    render();
    checkOver();
  }

  function checkOver() {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      if (!board[r][c]) return;
      if (r < 3 && board[r][c] === board[r+1][c]) return;
      if (c < 3 && board[r][c] === board[r][c+1]) return;
    }
    const el = document.getElementById('g2048-over');
    if (el) el.style.display = 'flex';
  }

  function render() {
    const grid = document.getElementById('g2048-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const v = board[r][c];
      const d = document.createElement('div');
      d.className = 'tile2048';
      d.textContent = v || '';
      d.style.background = COLORS[v] || (v > 2048 ? '#3c3a32' : '#cdc1b4');
      d.style.color = v > 4 ? '#f9f6f2' : '#776e65';
      d.style.fontSize = v >= 1000 ? (v >= 10000 ? '13px' : '17px') : '22px';
      grid.appendChild(d);
    }
    const s = document.getElementById('g2048-score'), b = document.getElementById('g2048-best');
    if (s) s.textContent = score;
    if (b) b.textContent = best;
  }

  function init() {
    document.addEventListener('keydown', e => {
      if (curGame !== '2048') return;
      const map = { ArrowLeft:'left', ArrowRight:'right', ArrowUp:'up', ArrowDown:'down' };
      if (map[e.key]) { e.preventDefault(); move(map[e.key]); }
    });

    let tx = 0, ty = 0;
    document.addEventListener('touchstart', e => {
      if (curGame !== '2048') return;
      tx = e.touches[0].clientX; ty = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', e => {
      if (curGame !== '2048') return;
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
      else move(dy > 0 ? 'down' : 'up');
    });

    const nb = document.getElementById('g2048-new');
    if (nb) nb.addEventListener('click', newGame);
    const rb = document.getElementById('g2048-retry');
    if (rb) rb.addEventListener('click', newGame);
  }

  return { newGame, init };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Minesweeper
// ═══════════════════════════════════════════════════════════════════════════════

const GMine = (() => {
  const CFGS = { easy:[9,9,10], med:[16,16,40], hard:[16,30,99] };
  const ADJ  = ['','#1a73e8','#388e3c','#d32f2f','#7b1fa2','#f57f17','#00838f','#424242','#757575'];
  let rows, cols, mines, board, firstClick, dead, won, flagCount, startTime, timerRef;

  function init(diff = 'easy') {
    [rows, cols, mines] = CFGS[diff] || CFGS.easy;
    board = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ mine:false, rev:false, flag:false, adj:0 })));
    firstClick = true; dead = false; won = false; flagCount = 0; startTime = null;
    clearInterval(timerRef);
    const t = document.getElementById('mine-timer');
    if (t) t.textContent = '0';
    updateCount();
    renderBoard();

    document.querySelectorAll('.diff-btn').forEach(b => b.classList.toggle('active', b.dataset.diff === diff));
  }

  function placeMines(sr, sc) {
    let placed = 0;
    while (placed < mines) {
      const r = Math.floor(Math.random() * rows);
      const c = Math.floor(Math.random() * cols);
      if (Math.abs(r-sr) <= 1 && Math.abs(c-sc) <= 1) continue;
      if (board[r][c].mine) continue;
      board[r][c].mine = true;
      placed++;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (board[r][c].mine) continue;
      let a = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
        if (board[r+dr]?.[c+dc]?.mine) a++;
      board[r][c].adj = a;
    }
  }

  function reveal(r, c) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const cell = board[r][c];
    if (cell.rev || cell.flag || dead) return;
    if (firstClick) {
      firstClick = false;
      placeMines(r, c);
      startTime = Date.now();
      timerRef = setInterval(() => {
        const t = document.getElementById('mine-timer');
        if (t) t.textContent = Math.floor((Date.now() - startTime) / 1000);
      }, 1000);
    }
    cell.rev = true;
    if (cell.mine) {
      dead = true;
      clearInterval(timerRef);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) board[i][j].rev = true;
      renderBoard();
      return;
    }
    if (!cell.adj) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
        if (dr || dc) reveal(r+dr, c+dc);
    }
  }

  function checkWin() {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
      if (!board[r][c].mine && !board[r][c].rev) return false;
    return true;
  }

  function renderBoard() {
    const el = document.getElementById('mine-board');
    if (!el) return;
    el.style.gridTemplateColumns = `repeat(${cols}, 28px)`;
    el.innerHTML = '';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      const d = document.createElement('div');
      d.className = 'mine-cell' + (cell.rev ? ' revealed' : '');
      if (cell.rev && cell.mine) { d.textContent = '💣'; d.classList.add('mine-hit'); }
      else if (cell.rev && cell.adj) { d.textContent = cell.adj; d.style.color = ADJ[cell.adj]; }
      else if (!cell.rev && cell.flag) d.textContent = '🚩';

      const R = r, C = c;
      d.addEventListener('click', () => {
        if (dead || won) return;
        reveal(R, C);
        renderBoard();
        if (!dead && checkWin()) {
          won = true; clearInterval(timerRef);
          setTimeout(() => alert('🎉 You win!'), 50);
        }
        updateCount();
      });

      let pressTimer;
      d.addEventListener('contextmenu', e => { e.preventDefault(); flag(R, C); });
      d.addEventListener('touchstart', () => { pressTimer = setTimeout(() => flag(R, C), 500); }, { passive: true });
      d.addEventListener('touchend',   () => clearTimeout(pressTimer), { passive: true });
      el.appendChild(d);
    }
  }

  function flag(r, c) {
    const cell = board[r][c];
    if (cell.rev || dead) return;
    cell.flag = !cell.flag;
    flagCount += cell.flag ? 1 : -1;
    renderBoard();
    updateCount();
  }

  function updateCount() {
    const el = document.getElementById('mine-count');
    if (el) el.textContent = mines - flagCount;
  }

  function initMine() {
    document.querySelectorAll('.diff-btn').forEach(b => {
      b.addEventListener('click', () => init(b.dataset.diff));
    });
  }

  return { init, initMine };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Chess UI
// ═══════════════════════════════════════════════════════════════════════════════

const GChess = (() => {
  const GLYPHS = { wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙', bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟' };
  const FILES  = 'abcdefgh';
  let game = null, myIdx = null, selected = null, legalCache = null, promoPending = null;

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderBoard(state) {
    const el = document.getElementById('chess-board');
    if (!el || !state) return;
    el.innerHTML = '';

    // ranks & files labels (only build once but rebuild is cheap)
    const ranks = document.getElementById('chess-ranks');
    const files = document.getElementById('chess-files');
    if (ranks) { ranks.innerHTML = ''; for (let r = 0; r < 8; r++) { const d=document.createElement('div'); d.className='chess-label'; d.textContent=8-r; ranks.appendChild(d); } }
    if (files) { files.innerHTML = ''; for (let c = 0; c < 8; c++) { const d=document.createElement('div'); d.className='chess-label'; d.textContent=FILES[c]; files.appendChild(d); } }

    const board    = state.board;
    const lastMove = state.lastMove;
    const inCheck  = state.inCheck; // 'w' | 'b' | null
    const myColor  = myIdx === 0 ? 'w' : 'b';

    // Determine last move squares from game history — we'll track via lastMove field if server sends it
    const hints = new Set(legalCache ? legalCache.map(([tr,tc]) => tr+','+tc) : []);

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement('div');
        const isLight = (r + c) % 2 === 0;
        sq.className = 'chess-sq ' + (isLight ? 'light' : 'dark');
        sq.dataset.r = r; sq.dataset.c = c;

        if (selected && selected[0] === r && selected[1] === c) sq.classList.add('selected');
        if (hints.has(r+','+c)) {
          sq.classList.add(board[r][c] ? 'hint-cap' : 'hint');
        }
        if (state.lastFrom && state.lastFrom[0]===r && state.lastFrom[1]===c) sq.classList.add('last-move');
        if (state.lastTo   && state.lastTo[0]===r   && state.lastTo[1]===c)   sq.classList.add('last-move');
        if (inCheck && board[r][c]?.type==='K' && board[r][c]?.color===inCheck) sq.classList.add('in-check');

        const piece = board[r][c];
        if (piece) {
          const glyph = document.createElement('span');
          glyph.className = 'chess-piece ' + piece.color;
          glyph.textContent = GLYPHS[piece.color + piece.type] || '?';
          sq.appendChild(glyph);
        }

        sq.addEventListener('click', () => onSquareClick(r, c, state));
        el.appendChild(sq);
      }
    }
  }

  function onSquareClick(r, c, state) {
    if (!game || game.status !== 'active') return;
    if (myIdx !== game.turn) return; // not my turn
    const myColor = myIdx === 0 ? 'w' : 'b';

    // If a piece is already selected, try to move
    if (selected) {
      const [fr, fc] = selected;
      const isHint = legalCache && legalCache.some(([tr,tc]) => tr===r && tc===c);

      if (isHint) {
        // Check for promotion
        const piece = state.board[fr][fc];
        if (piece.type === 'P' && ((myColor==='w' && r===0) || (myColor==='b' && r===7))) {
          // Show promotion picker
          promoPending = { fr, fc, tr:r, tc:c };
          showPromo();
          return;
        }
        sendMove(fr, fc, r, c, null);
        selected = null; legalCache = null;
        return;
      }

      // Re-select own piece
      if (state.board[r][c]?.color === myColor) {
        selected = [r, c];
        legalCache = getClientLegalMoves(state, r, c, myColor);
        renderBoard(state);
        return;
      }

      // Deselect
      selected = null; legalCache = null;
      renderBoard(state);
      return;
    }

    // Select a piece
    if (state.board[r][c]?.color === myColor) {
      selected = [r, c];
      legalCache = getClientLegalMoves(state, r, c, myColor);
      renderBoard(state);
    }
  }

  // Client-side legal move hints — we rely on server for validation,
  // but we compute approximate hints to avoid a round-trip per click.
  function getClientLegalMoves(state, fr, fc, myColor) {
    // Simple: mark all squares in the same rough direction as reachable
    // (server will reject illegal ones). For a better UX we do a real client check.
    return computeClientMoves(state, fr, fc);
  }

  // Minimal pseudo-move generator mirroring server logic (enough for UI hints).
  function computeClientMoves(state, fr, fc) {
    const board  = state.board;
    const piece  = board[fr][fc];
    if (!piece) return [];
    const { type, color } = piece;
    const enemy = color === 'w' ? 'b' : 'w';
    const castling = state.castling || {};
    const ep = state.enPassant || null;
    const moves = [];

    const slide = (dr, dc) => {
      let nr = fr+dr, nc = fc+dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        if (board[nr][nc]) { if (board[nr][nc].color === enemy) moves.push([nr,nc]); break; }
        moves.push([nr,nc]); nr+=dr; nc+=dc;
      }
    };

    if (type === 'P') {
      const d = color === 'w' ? -1 : 1, sr = color === 'w' ? 6 : 1;
      if (fr+d >= 0 && fr+d < 8 && !board[fr+d][fc]) {
        moves.push([fr+d, fc]);
        if (fr===sr && !board[fr+2*d][fc]) moves.push([fr+2*d, fc]);
      }
      for (const dc of [-1,1]) if (fc+dc>=0&&fc+dc<8&&fr+d>=0&&fr+d<8&&board[fr+d][fc+dc]?.color===enemy) moves.push([fr+d,fc+dc]);
      if (ep && fr+d===ep.row && Math.abs(fc-ep.col)===1) moves.push([ep.row,ep.col]);
    } else if (type==='R') { slide(1,0);slide(-1,0);slide(0,1);slide(0,-1); }
    else if (type==='B')   { slide(1,1);slide(1,-1);slide(-1,1);slide(-1,-1); }
    else if (type==='Q')   { slide(1,0);slide(-1,0);slide(0,1);slide(0,-1);slide(1,1);slide(1,-1);slide(-1,1);slide(-1,-1); }
    else if (type==='N')   { for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const nr=fr+dr,nc=fc+dc; if (nr>=0&&nr<8&&nc>=0&&nc<8&&board[nr][nc]?.color!==color) moves.push([nr,nc]); } }
    else if (type==='K') {
      for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) { const nr=fr+dr,nc=fc+dc; if (nr>=0&&nr<8&&nc>=0&&nc<8&&board[nr][nc]?.color!==color) moves.push([nr,nc]); }
      const row = color==='w'?7:0;
      if (fr===row&&fc===4) {
        if ((color==='w'?castling.wk:castling.bk)&&!board[row][5]&&!board[row][6]) moves.push([row,6]);
        if ((color==='w'?castling.wq:castling.bq)&&!board[row][3]&&!board[row][2]&&!board[row][1]) moves.push([row,2]);
      }
    }
    return moves;
  }

  function showPromo() {
    const el = document.getElementById('chess-promo');
    if (!el) return;
    const myColor = myIdx === 0 ? 'w' : 'b';
    const PROMO_W = { Q:'♕', R:'♖', B:'♗', N:'♘' };
    const PROMO_B = { Q:'♛', R:'♜', B:'♝', N:'♞' };
    const glyphs  = myColor === 'w' ? PROMO_W : PROMO_B;
    el.querySelectorAll('.promo-btn').forEach(b => { b.textContent = glyphs[b.dataset.piece]; });
    el.style.display = 'flex';
  }

  function updateStatus(g) {
    const el = document.getElementById('chess-status');
    if (!el) return;
    if (g.status === 'waiting') { el.textContent = 'Waiting for opponent…'; return; }
    if (g.status === 'done') {
      if (g.winner === 'draw') el.textContent = '½–½ Draw';
      else if (g.winner === myIdx) el.textContent = '🎉 You won!';
      else el.textContent = 'You lost.';
      const rm = document.getElementById('chess-rematch');
      if (rm) rm.style.display = '';
      return;
    }
    const turn = g.turn === myIdx ? 'Your turn' : "Opponent's turn";
    el.textContent = g.state.inCheck ? `⚠️ Check — ${turn}` : turn;
  }

  function applyGameState(g) {
    game = g;
    selected  = null;
    legalCache = null;
    updateStatus(g);
    renderBoard(g.state);
    const actions = document.getElementById('chess-actions');
    if (actions) actions.style.display = g.status === 'active' ? '' : 'none';
    if (g.status !== 'active') {
      const rm = document.getElementById('chess-rematch');
      if (rm) rm.style.display = '';
    }
  }

  function sendMove(fr, fc, tr, tc, promo) {
    wsSend({ type: 'game:move', gameId: game.id, from: [fr,fc], to: [tr,tc], promotion: promo });
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  function initChessUI() {
    const createBtn = document.getElementById('chess-join-btn');
    const joinInput = document.getElementById('chess-join-input');
    const copyBtn   = document.getElementById('chess-copy-code');
    const resignBtn = document.getElementById('chess-resign');
    const rematchBtn= document.getElementById('chess-rematch');

    // Create or join
    if (createBtn) createBtn.addEventListener('click', () => {
      const code = joinInput?.value.trim().toLowerCase();
      if (code && code.length === 6) {
        wsSend({ type: 'game:join', gameId: code });
      } else {
        wsSend({ type: 'game:create', gameType: 'chess' });
      }
    });

    if (copyBtn) copyBtn.addEventListener('click', () => {
      const code = document.getElementById('chess-room-code')?.textContent;
      if (code) navigator.clipboard.writeText(code).catch(() => {});
    });

    if (resignBtn) resignBtn.addEventListener('click', () => {
      if (game) wsSend({ type: 'game:resign', gameId: game.id });
    });

    if (rematchBtn) rematchBtn.addEventListener('click', () => {
      if (game) wsSend({ type: 'game:rematch', gameId: game.id });
    });

    // Promotion picker
    document.querySelectorAll('.promo-btn').forEach(b => {
      b.addEventListener('click', () => {
        const promo = b.dataset.piece;
        if (promoPending) {
          sendMove(promoPending.fr, promoPending.fc, promoPending.tr, promoPending.tc, promo);
          promoPending = null;
        }
        const el = document.getElementById('chess-promo');
        if (el) el.style.display = 'none';
      });
    });
  }

  function onGameCreated(g) {
    myIdx = 0;
    game  = g;
    const ri = document.getElementById('chess-room-info');
    const rc = document.getElementById('chess-room-code');
    const ja = document.getElementById('chess-join-area');
    if (ri) ri.style.display = '';
    if (rc) rc.textContent  = g.id.toUpperCase();
    if (ja) ja.style.display = 'none';
    updateStatus(g);
    renderBoard(g.state);
  }

  function onGameJoined(g) {
    if (!game || game.id !== g.id) myIdx = g.players.indexOf(deviceId);
    applyGameState(g);
    const ri = document.getElementById('chess-room-info');
    const ja = document.getElementById('chess-join-area');
    if (ri) ri.style.display = 'none';
    if (ja) ja.style.display = 'none';
  }

  return { initChessUI, onGameCreated, onGameJoined, applyGameState };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Connect Four UI
// ═══════════════════════════════════════════════════════════════════════════════

const GC4 = (() => {
  let game = null, myIdx = null;

  function renderBoard(g) {
    const board = g.state.board;
    const wins  = g.state.winCells || [];
    const winSet = new Set(wins.map(([r,c]) => r+','+c));

    const el = document.getElementById('c4-board');
    if (!el) return;
    el.innerHTML = '';
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
      const d = document.createElement('div');
      d.className = 'c4-cell' + (board[r][c] === 1 ? ' p1' : board[r][c] === 2 ? ' p2' : '');
      if (winSet.has(r+','+c)) d.classList.add('win');
      el.appendChild(d);
    }

    // Drop buttons
    const dropRow = document.getElementById('c4-drop-row');
    if (!dropRow) return;
    dropRow.innerHTML = '';
    const canPlay = g.status === 'active' && myIdx === g.turn;
    for (let c = 0; c < 7; c++) {
      const btn = document.createElement('button');
      btn.className = 'c4-drop-btn';
      btn.textContent = '▼';
      btn.disabled = !canPlay || board[0][c] !== 0;
      const C = c;
      btn.addEventListener('click', () => {
        if (game) wsSend({ type: 'game:move', gameId: game.id, col: C });
      });
      dropRow.appendChild(btn);
    }
  }

  function updateStatus(g) {
    const el = document.getElementById('c4-status');
    if (!el) return;
    const p1Label = document.getElementById('c4-p1-label');
    const p2Label = document.getElementById('c4-p2-label');
    const isP1 = myIdx === 0;

    if (p1Label) p1Label.textContent = isP1 ? 'You (Red)' : 'Opponent (Red)';
    if (p2Label) p2Label.textContent = isP1 ? 'Opponent (Yellow)' : 'You (Yellow)';

    if (g.status === 'waiting') { el.textContent = 'Waiting for opponent…'; return; }
    if (g.status === 'done') {
      if (g.winner === 'draw') el.textContent = '½–½ Draw!';
      else if (g.winner === myIdx) el.textContent = '🎉 You won!';
      else el.textContent = 'You lost.';
      const rm = document.getElementById('c4-rematch');
      if (rm) rm.style.display = '';
      return;
    }
    el.textContent = g.turn === myIdx ? 'Your turn' : "Opponent's turn";
  }

  function applyGameState(g) {
    game = g;
    updateStatus(g);
    renderBoard(g);
    const actions = document.getElementById('c4-actions');
    if (actions) actions.style.display = g.status === 'active' ? '' : 'none';
    if (g.status !== 'active') {
      const rm = document.getElementById('c4-rematch');
      if (rm) rm.style.display = '';
    }
  }

  function onGameCreated(g) {
    myIdx = 0; game = g;
    const ri = document.getElementById('c4-room-info');
    const rc = document.getElementById('c4-room-code');
    const ja = document.getElementById('c4-join-area');
    if (ri) ri.style.display = '';
    if (rc) rc.textContent  = g.id.toUpperCase();
    if (ja) ja.style.display = 'none';
    updateStatus(g);
    renderBoard(g);
  }

  function onGameJoined(g) {
    if (!game || game.id !== g.id) myIdx = g.players.indexOf(deviceId);
    applyGameState(g);
    const ri = document.getElementById('c4-room-info');
    const ja = document.getElementById('c4-join-area');
    if (ri) ri.style.display = 'none';
    if (ja) ja.style.display = 'none';
  }

  function initC4UI() {
    const createBtn  = document.getElementById('c4-join-btn');
    const joinInput  = document.getElementById('c4-join-input');
    const copyBtn    = document.getElementById('c4-copy-code');
    const resignBtn  = document.getElementById('c4-resign');
    const rematchBtn = document.getElementById('c4-rematch');

    if (createBtn) createBtn.addEventListener('click', () => {
      const code = joinInput?.value.trim().toLowerCase();
      if (code && code.length === 6) {
        wsSend({ type: 'game:join', gameId: code });
      } else {
        wsSend({ type: 'game:create', gameType: 'connect4' });
      }
    });

    if (copyBtn) copyBtn.addEventListener('click', () => {
      const code = document.getElementById('c4-room-code')?.textContent;
      if (code) navigator.clipboard.writeText(code).catch(() => {});
    });

    if (resignBtn) resignBtn.addEventListener('click', () => {
      if (game) wsSend({ type: 'game:resign', gameId: game.id });
    });

    if (rematchBtn) rematchBtn.addEventListener('click', () => {
      if (game) wsSend({ type: 'game:rematch', gameId: game.id });
    });
  }

  return { initC4UI, onGameCreated, onGameJoined, applyGameState };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket message handler (called from index.html's ws.onmessage)
// ═══════════════════════════════════════════════════════════════════════════════

function gamesOnMessage(msg) {
  if (msg.type === 'game:created') {
    if (msg.game.type === 'chess')    GChess.onGameCreated(msg.game);
    if (msg.game.type === 'connect4') GC4.onGameCreated(msg.game);
  }
  if (msg.type === 'game:joined' || msg.type === 'game:state') {
    if (msg.game.type === 'chess')    GChess.onGameJoined(msg.game);
    if (msg.game.type === 'connect4') GC4.onGameJoined(msg.game);
  }
  if (msg.type === 'game:rematch') {
    if (msg.game.type === 'chess')    GChess.onGameJoined(msg.game);
    if (msg.game.type === 'connect4') GC4.onGameJoined(msg.game);
  }
  if (msg.type === 'game:error') {
    // Show brief error in whichever panel is open
    const panel = document.getElementById('panel-' + curGame);
    if (!panel) return;
    const statusEl = panel.querySelector('.game-status-box');
    if (statusEl) { const prev = statusEl.textContent; statusEl.textContent = '⚠️ ' + msg.error; setTimeout(() => { statusEl.textContent = prev; }, 2500); }
  }
}

// ─── Helper to send WS messages from games tab ────────────────────────────────
function wsSend(obj) {
  if (typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init2048() { G2048.init(); }
function initMinesweeper() { GMine.initMine(); }
function initChessUI()  { GChess.initChessUI(); }
function initC4UI()     { GC4.initC4UI(); }
