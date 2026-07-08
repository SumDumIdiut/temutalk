// ── News (BBC RSS via /api/news) ──────────────────────────────────────────────
let newsLoaded = false;
let newsFeed = 'top';

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
    const r = await fetch('/api/news?cat=' + encodeURIComponent(newsFeed) + '&device=' + deviceId);
    const items = await r.json();
    if (!Array.isArray(items)) throw new Error(items.error || 'bad response');
    newsLoaded = true;
    list.innerHTML = '';
    for (const s of items) {
      const card = document.createElement('a');
      card.className = 'news-card';
      card.href = s.link;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.innerHTML =
        (s.thumbnail ? '<img class="news-thumb" src="' + newsEsc(s.thumbnail) + '" alt="" loading="lazy">' : '') +
        '<div class="news-body">' +
          '<div class="news-title">' + newsEsc(s.title) + '</div>' +
          (s.description ? '<div class="news-desc">' + newsEsc(s.description) + '</div>' : '') +
          '<div class="news-meta">' +
            '<span class="news-source">' + newsEsc(s.source || 'BBC News') + '</span>' +
            '<span>' + newsTimeAgo(s.pubDate) + '</span>' +
          '</div>' +
        '</div>';
      list.appendChild(card);
    }
    if (!items.length) list.innerHTML = '<div style="padding:24px 0;color:var(--text-muted);font-size:14px;text-align:center;">No stories right now.</div>';
  } catch (e) {
    list.innerHTML = '<div style="padding:24px 0;color:var(--text-muted);font-size:14px;text-align:center;">Could not load news.</div>';
  }
}

function newsTimeAgo(pubDate) {
  const t = Date.parse(pubDate || '');
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 1000);
  if (d < 60)    return 'just now';
  if (d < 3600)  return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function newsEsc(s) {
  return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
}
