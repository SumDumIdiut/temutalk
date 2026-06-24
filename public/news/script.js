// ── News (Hacker News) ────────────────────────────────────────────────────────
let newsLoaded = false;
let newsFeed = 'topstories';
let newsIds = [];

function setNewsFeed(feed, btn) {
  if (feed === newsFeed && newsLoaded) return;
  newsFeed = feed;
  document.querySelectorAll('.news-sub-btn').forEach(b => b.classList.toggle('active', b === btn));
  newsLoaded = false;
  loadNews();
}

async function loadNews() {
  if (newsLoaded) return;
  const list = document.getElementById('news-list');
  list.innerHTML = '<div style="padding:24px 0;color:var(--text-muted);font-size:14px;text-align:center;">Loading…</div>';
  try {
    const r = await fetch(`https://hacker-news.firebaseio.com/v0/${newsFeed}.json`);
    newsIds = await r.json();
    newsLoaded = true;
    await renderNewsItems(newsIds.slice(0, 30));
  } catch {
    list.innerHTML = '<div style="padding:24px 0;color:var(--text-muted);font-size:14px;text-align:center;">Could not load news.</div>';
  }
}

async function renderNewsItems(ids) {
  const list = document.getElementById('news-list');
  const stories = await Promise.all(ids.map(id =>
    fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()).catch(() => null)
  ));
  list.innerHTML = '';
  for (const s of stories) {
    if (!s || !s.title) continue;
    let domain = 'news.ycombinator.com';
    try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
    const card = document.createElement('a');
    card.className = 'news-card';
    card.href = s.url || `https://news.ycombinator.com/item?id=${s.id}`;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.innerHTML =
      '<div class="news-body">' +
        '<div class="news-title">' + newsEsc(s.title) + '</div>' +
        '<div class="news-meta">' +
          '<span class="news-source">' + newsEsc(domain) + '</span>' +
          '<span>' + (s.score || 0) + ' pts</span>' +
          '<span>' + (s.descendants || 0) + ' comments</span>' +
          '<span>' + newsTimeAgo(s.time) + '</span>' +
        '</div>' +
      '</div>';
    list.appendChild(card);
  }
}

function newsTimeAgo(ts) {
  if (!ts) return '';
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60)    return d + 's ago';
  if (d < 3600)  return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function newsEsc(s) {
  return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
}