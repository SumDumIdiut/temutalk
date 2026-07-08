// Voice assistant: POST /api/assistant runs a tool-use loop on a local
// Ollama model over the hub's data sources (Spotify, radio, weather,
// finance, news, chat, timers).
//
// Server tools execute here; device tools (play radio, set timer, send chat,
// navigate) are queued into `actions` and returned to the browser, which
// executes them with the existing tab-script globals (playStation, addTimer…).
//
// Needs Ollama running (default http://localhost:11434) with a tool-calling
// model pulled, e.g. `ollama pull llama3.1`. Override via OLLAMA_URL and
// ASSISTANT_MODEL in .env.

const axios    = require('axios');
const express  = require('express');
const FormData = require('form-data');
const { spawn } = require('child_process');

const state = require('./state');
const { devices, getDeviceToken } = require('./devices');
const { transferAndPlay, activateDevice } = require('./spotify');
const { searchRadio, radioCacheReady, fetchWeather, fetchNews } = require('./data');

const OLLAMA_URL  = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const MODEL       = process.env.ASSISTANT_MODEL || 'llama3.1';
const WHISPER_URL = (process.env.WHISPER_URL || 'http://localhost:11435').replace(/\/$/, '');
const MAX_TURNS   = 6;

// ─── System prompt (stable — volatile context goes in the user message) ──────
const SYSTEM_PROMPT = `You are the voice assistant built into TemuTalk, a smart home hub with tabs for music (Spotify), live radio, weather, finance (stocks/crypto/forex), news (Hacker News), timers, and chat between household devices.

Your reply is spoken aloud through text-to-speech, so:
- Answer in 1-3 short conversational sentences of plain text. No markdown, no lists, no emoji, no URLs.
- Round numbers sensibly for speech (say "about 97 thousand dollars", not "$97,142.33").
- When asked to do something, just do it with your tools and confirm briefly.
- When summarising news or weather, pick out only the few most interesting points.
- Device tools (radio, timers, chat messages, navigation) are queued and run on the user's device the moment you finish - treat a "queued" tool result as success.
- If a tool fails (e.g. Spotify not connected), say what's wrong in one sentence and how to fix it.
- If a request is outside what your tools can do, say so briefly.
- Always call a tool when one matches the request instead of guessing or answering from memory. After the tools have answered, reply to the user without calling more tools.
- You will get a "Device context" system message before the user's request (date/time, weather city, Spotify status, etc). Use it silently to inform tool calls — never quote, repeat, or mention that block in your reply.`;

// ─── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_weather',
    description: 'Get current weather and today\'s forecast for a city. Call with no city to use the hub\'s default.',
    input_schema: { type: 'object', properties: {
      city: { type: 'string', description: 'City name, e.g. "Cape Town". Optional.' },
    } },
  },
  {
    name: 'get_crypto_prices',
    description: 'Current prices and 24h change for cryptocurrencies.',
    input_schema: { type: 'object', properties: {
      ids: { type: 'string', description: 'Comma-separated CoinGecko ids, e.g. "bitcoin,ethereum,solana". Defaults to the top 10.' },
    } },
  },
  {
    name: 'get_stock',
    description: 'Current price and daily change for a stock, index, or forex pair. Call this when the user asks about a share price, an index, or an exchange rate.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Ticker or company name, e.g. "AAPL", "Tesla", "S&P 500", "USD/ZAR".' },
    }, required: ['query'] },
  },
  {
    name: 'get_news',
    description: 'Current BBC News headlines. Call this when the user asks for the news or what\'s happening.',
    input_schema: { type: 'object', properties: {
      category: { type: 'string', enum: ['top', 'world', 'tech', 'business', 'science', 'sport'], description: 'News category (default top).' },
      count: { type: 'integer', description: 'How many headlines (default 10, max 15).' },
    } },
  },
  {
    name: 'get_player_state',
    description: 'What is currently playing on this device (Spotify track and/or radio station), whether Spotify is connected, and playback position. Call this before answering "what song is this" or before pausing/skipping.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_music',
    description: 'Search Spotify for tracks. Use when the user wants options or you are unsure of the exact song; to just play something, call play_music directly.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Song, artist, or album search text.' },
    }, required: ['query'] },
  },
  {
    name: 'play_music',
    description: 'Search Spotify and immediately play the best-matching track on this device. Call this when the user asks to play a song or artist. Do NOT use this for playlists — call play_playlist instead.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to play, e.g. "Bohemian Rhapsody by Queen".' },
    }, required: ['query'] },
  },
  {
    name: 'play_playlist',
    description: 'Find one of the user\'s own Spotify playlists by name and play it on this device. Call this whenever the user asks to play "my playlist <name>" or a playlist they own.',
    input_schema: { type: 'object', properties: {
      name: { type: 'string', description: 'The playlist name only — strip filler words like "my playlist" or "the playlist called". E.g. for "play my playlist workout" pass "workout".' },
    }, required: ['name'] },
  },
  {
    name: 'add_to_playlist',
    description: 'Add a track to one of the user\'s own Spotify playlists. If no track is given, adds whatever is currently playing on this device. Call this for requests like "add this to my playlist <name>" or "add <song> to <name>".',
    input_schema: { type: 'object', properties: {
      playlist_name: { type: 'string', description: 'The playlist name only, e.g. "road trip".' },
      track_query:   { type: 'string', description: 'Optional song to add instead of the currently playing track, e.g. "Bohemian Rhapsody by Queen".' },
    }, required: ['playlist_name'] },
  },
  {
    name: 'control_playback',
    description: 'Control Spotify playback on this device: resume, pause, or skip.',
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['play', 'pause', 'next', 'previous'] },
    }, required: ['action'] },
  },
  {
    name: 'set_volume',
    description: 'Set Spotify playback volume (0-100 percent).',
    input_schema: { type: 'object', properties: {
      percent: { type: 'integer', description: '0 to 100' },
    }, required: ['percent'] },
  },
  {
    name: 'play_radio',
    description: 'Find a live radio station by name, genre, or country and start playing it on the user\'s device. Call this when the user asks to play the radio or a specific station.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Station name, genre, or country, e.g. "BBC Radio 1", "jazz france".' },
    }, required: ['query'] },
  },
  {
    name: 'stop_radio',
    description: 'Stop the radio currently playing on the user\'s device.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'send_chat_message',
    description: 'Send a chat message from this user to the hub\'s chat. Sends to the global room unless another room id is given.',
    input_schema: { type: 'object', properties: {
      text: { type: 'string', description: 'The message text to send.' },
      room: { type: 'string', description: 'Room id (default "global").' },
    }, required: ['text'] },
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer on the user\'s device. It beeps when done.',
    input_schema: { type: 'object', properties: {
      seconds: { type: 'integer', description: 'Duration in seconds.' },
      label:   { type: 'string',  description: 'Short label, e.g. "Pasta". Optional.' },
    }, required: ['seconds'] },
  },
  {
    name: 'navigate',
    description: 'Switch the hub UI to a tab on the user\'s device.',
    input_schema: { type: 'object', properties: {
      tab: { type: 'string', enum: ['home', 'music', 'radio', 'finance', 'news', 'weather', 'timer', 'chat', 'system'] },
    }, required: ['tab'] },
  },
];

// ─── Server-side tool implementations ─────────────────────────────────────────
const UA = { 'User-Agent': 'TemuTalk/1.0' };

async function spotifyToken(deviceId) {
  const token = await getDeviceToken(deviceId);
  if (!token) throw new Error('Spotify is not connected on this device. Connect it from the Music tab.');
  return token;
}

async function toolGetWeather(input, ctx) {
  // No explicit city → device GPS coords (reverse-geocoded in fetchWeather) → server default
  const city = (input.city || ctx.coords || ctx.weatherCity || 'London').trim();
  const data = await fetchWeather(city);
  const c = data.current_condition?.[0];
  const day = data.weather?.[0];
  if (!c) throw new Error('Weather service returned no data for ' + city);
  return {
    city: data.nearest_area?.[0]?.areaName?.[0]?.value || city,
    now: {
      tempC: +c.temp_C, feelsLikeC: +c.FeelsLikeC,
      description: c.weatherDesc?.[0]?.value,
      humidityPct: +c.humidity, windKmh: +c.windspeedKmph,
    },
    today: day ? {
      minC: +day.mintempC, maxC: +day.maxtempC,
      sunrise: day.astronomy?.[0]?.sunrise, sunset: day.astronomy?.[0]?.sunset,
      maxChanceOfRainPct: Math.max(...(day.hourly || []).map(h => +h.chanceofrain || 0)),
    } : null,
  };
}

async function toolGetCrypto(input) {
  const ids = (input.ids || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,avalanche-2,polkadot,chainlink').replace(/[^a-z0-9,\-]/g, '');
  const r = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
    params: { vs_currency: 'usd', ids, order: 'market_cap_desc', per_page: 15, page: 1, price_change_percentage: '24h' },
    timeout: 10000,
  });
  return r.data.map(c => ({
    name: c.name, symbol: c.symbol.toUpperCase(),
    priceUsd: c.current_price, change24hPct: +(c.price_change_percentage_24h || 0).toFixed(2),
  }));
}

async function toolGetStock(input) {
  const q = String(input.query || '').trim();
  const yh = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
  const sr = await axios.get('https://query1.finance.yahoo.com/v1/finance/search', {
    params: { q, quotesCount: 3, newsCount: 0, listsCount: 0 }, headers: yh, timeout: 8000,
  });
  const quote = (sr.data.quotes || []).find(x => x.symbol);
  if (!quote) throw new Error('No stock or currency pair found for "' + q + '"');
  const cr = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(quote.symbol)}`, {
    params: { interval: '5m', range: '1d' }, headers: yh, timeout: 10000,
  });
  const meta = cr.data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No price data for ' + quote.symbol);
  const price = meta.regularMarketPrice, prev = meta.chartPreviousClose || meta.previousClose;
  return {
    symbol: meta.symbol, name: quote.shortname || quote.longname || meta.symbol,
    price, currency: meta.currency,
    changePct: prev ? +((price - prev) / prev * 100).toFixed(2) : null,
  };
}

async function toolGetNews(input) {
  const count = Math.min(Math.max(parseInt(input.count, 10) || 10, 1), 15);
  const items = await fetchNews(input.category || 'top', count);
  return items.map(s => ({ title: s.title, summary: s.description }));
}

function toolGetPlayerState(deviceId) {
  const player = state.playerStateCache.get(deviceId);
  const radio  = state.radioNowPlaying.get(deviceId);
  const out = {
    spotifyConnected: !!(devices.get(deviceId)?.tokens?.access_token),
    spotify: null,
    radio: radio ? { station: radio.name } : null,
  };
  if (player?.item) {
    out.spotify = {
      isPlaying: !!player.is_playing,
      track: player.item.name,
      artists: (player.item.artists || []).map(a => a.name).join(', '),
      album: player.item.album?.name,
      progressSec: Math.round((player.progress_ms || 0) / 1000),
      durationSec: Math.round((player.item.duration_ms || 0) / 1000),
      volumePct: player.device?.volume_percent ?? null,
    };
  }
  return out;
}

async function spotifySearchTracks(deviceId, query, limit) {
  const token = await spotifyToken(deviceId);
  const r = await axios.get('https://api.spotify.com/v1/search', {
    params: { q: query, type: 'track', limit },
    headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
  });
  return { token, tracks: (r.data.tracks?.items || []).map(t => ({
    name: t.name, artists: t.artists.map(a => a.name).join(', '), album: t.album?.name, uri: t.uri,
    albumType: t.album?.album_type,
  })) };
}

// Spotify's search often ranks a "Greatest Hits"/decade compilation reissue
// above the track's original studio album (same recording, different
// release) — plays the identical song either way, but picking the
// compilation looks wrong (its cover reads as a curated playlist, not "the
// song"). Prefer the first non-compilation result when one's available.
function pickBestTrackMatch(tracks) {
  return tracks.find(t => t.albumType !== 'compilation') || tracks[0];
}

async function spotifyGetPlaylists(deviceId) {
  const token = await spotifyToken(deviceId);
  const r = await axios.get('https://api.spotify.com/v1/me/playlists', {
    params: { limit: 50 }, headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
  });
  return { token, playlists: r.data.items || [] };
}

// Exact name match first, then prefix, then substring either direction —
// handles "playlist called workout" (query contains extra words) and
// "play my playlist playlist" (playlist literally named "playlist").
function fuzzyFindPlaylist(playlists, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return playlists.find(p => p.name.toLowerCase() === q)
      || playlists.find(p => p.name.toLowerCase().startsWith(q))
      || playlists.find(p => p.name.toLowerCase().includes(q))
      || playlists.find(p => q.includes(p.name.toLowerCase()))
      || null;
}

async function toolPlayPlaylist(input, deviceId) {
  const { token, playlists } = await spotifyGetPlaylists(deviceId);
  if (!playlists.length) throw new Error('No Spotify playlists found on this account.');
  const match = fuzzyFindPlaylist(playlists, input.name);
  if (!match) {
    const names = playlists.slice(0, 8).map(p => p.name).join(', ');
    throw new Error(`No playlist found matching "${input.name}". Playlists on this account: ${names}.`);
  }
  await playWithRetry(token, { context_uri: match.uri });
  return `Now playing your playlist "${match.name}" (${match.tracks?.total ?? '?'} tracks).`;
}

async function toolAddToPlaylist(input, deviceId) {
  const token = await spotifyToken(deviceId);

  let trackUri, trackName, trackArtists;
  if (input.track_query && input.track_query.trim()) {
    const { tracks } = await spotifySearchTracks(deviceId, input.track_query, 5);
    if (!tracks.length) throw new Error(`No Spotify results for "${input.track_query}"`);
    ({ uri: trackUri, name: trackName, artists: trackArtists } = pickBestTrackMatch(tracks));
  } else {
    const player = state.playerStateCache.get(deviceId);
    if (!player?.item) throw new Error('Nothing is currently playing to add — say a song name instead.');
    trackUri = player.item.uri;
    trackName = player.item.name;
    trackArtists = (player.item.artists || []).map(a => a.name).join(', ');
  }

  const { playlists } = await spotifyGetPlaylists(deviceId);
  const match = fuzzyFindPlaylist(playlists, input.playlist_name);
  if (!match) {
    const names = playlists.slice(0, 8).map(p => p.name).join(', ');
    throw new Error(`No playlist found matching "${input.playlist_name}". Playlists on this account: ${names}.`);
  }

  try {
    await axios.post(`https://api.spotify.com/v1/playlists/${match.id}/tracks`, { uris: [trackUri] }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (e.response?.status === 403) throw new Error('Spotify permission missing to edit playlists — disconnect and reconnect Spotify from the Music tab to grant it.');
    throw new Error(e.response?.data?.error?.message || e.message);
  }
  return `Added "${trackName}" by ${trackArtists} to your playlist "${match.name}".`;
}

// Spotify's Connect API returns 404 when there's no active device, but also
// transiently 502/503 while a device is still waking up from transfer — both
// mean "retry against an explicitly activated device", not a hard failure.
const NO_ACTIVE_DEVICE_STATUSES = [404, 502, 503];

async function playWithRetry(token, playBody) {
  try {
    await transferAndPlay(token, playBody, null);
    return;
  } catch (e) {
    if (!NO_ACTIVE_DEVICE_STATUSES.includes(e.response?.status)) {
      throw new Error(e.response?.data?.error?.message || e.message);
    }
  }
  const spDeviceId = await activateDevice(token);
  if (!spDeviceId) throw new Error('No Spotify playback device available. Open Spotify on a device first.');
  try {
    await transferAndPlay(token, playBody, spDeviceId);
  } catch (e) {
    if (!NO_ACTIVE_DEVICE_STATUSES.includes(e.response?.status)) throw new Error(e.response?.data?.error?.message || e.message);
    // Device can still be a beat behind right after transfer — one short retry.
    await new Promise(res => setTimeout(res, 1200));
    try { await transferAndPlay(token, playBody, spDeviceId); }
    catch (e2) { throw new Error(e2.response?.data?.error?.message || 'Spotify device is still waking up — try again in a moment.'); }
  }
}

async function toolPlayMusic(input, deviceId) {
  const { token, tracks } = await spotifySearchTracks(deviceId, input.query, 5);
  if (!tracks.length) throw new Error('No Spotify results for "' + input.query + '"');
  const t = pickBestTrackMatch(tracks);
  await playWithRetry(token, { uris: [t.uri] });
  return `Now playing "${t.name}" by ${t.artists}.`;
}

async function toolControlPlayback(input, deviceId) {
  const token = await spotifyToken(deviceId);
  const map = {
    play:     ['put',  'https://api.spotify.com/v1/me/player/play'],
    pause:    ['put',  'https://api.spotify.com/v1/me/player/pause'],
    next:     ['post', 'https://api.spotify.com/v1/me/player/next'],
    previous: ['post', 'https://api.spotify.com/v1/me/player/previous'],
  };
  const [method, url] = map[input.action] || [];
  if (!method) throw new Error('Unknown action ' + input.action);
  await axios[method](url, {}, { headers: { Authorization: `Bearer ${token}` } });
  return 'OK — ' + input.action + ' sent.';
}

async function toolSetVolume(input, deviceId) {
  const token = await spotifyToken(deviceId);
  const vol = Math.min(Math.max(parseInt(input.percent, 10) || 0, 0), 100);
  await axios.put(`https://api.spotify.com/v1/me/player/volume?volume_percent=${vol}`, {}, { headers: { Authorization: `Bearer ${token}` } });
  return `Volume set to ${vol}%.`;
}

function toolPlayRadio(input, actions) {
  if (!radioCacheReady()) throw new Error('The radio station list is still loading — try again in a minute.');
  const matches = searchRadio(input.query, 1);
  if (!matches.length) throw new Error('No radio station found matching "' + input.query + '"');
  const s = matches[0];
  actions.push({ type: 'play_radio', station: s });
  return `Queued "${s.name}" (${s.country || 'unknown country'}, ${s.bitrate || '?'} kbps) to play on the device.`;
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────
async function runTool(name, input, ctx) {
  const { deviceId, actions } = ctx;
  switch (name) {
    case 'get_weather':        return toolGetWeather(input, ctx);
    case 'get_crypto_prices':  return toolGetCrypto(input);
    case 'get_stock':          return toolGetStock(input);
    case 'get_news':           return toolGetNews(input);
    case 'get_player_state':   return toolGetPlayerState(deviceId);
    case 'search_music':       return (await spotifySearchTracks(deviceId, input.query, 5)).tracks;
    case 'play_music':         return toolPlayMusic(input, deviceId);
    case 'play_playlist':      return toolPlayPlaylist(input, deviceId);
    case 'add_to_playlist':    return toolAddToPlaylist(input, deviceId);
    case 'control_playback':   return toolControlPlayback(input, deviceId);
    case 'set_volume':         return toolSetVolume(input, deviceId);
    case 'play_radio':         return toolPlayRadio(input, actions);
    case 'stop_radio':
      actions.push({ type: 'stop_radio' });
      return 'Queued: radio will stop on the device.';
    case 'send_chat_message': {
      const text = String(input.text || '').trim().slice(0, 2000);
      if (!text) throw new Error('Empty message');
      actions.push({ type: 'send_chat', text, room: String(input.room || 'global') });
      return 'Queued: message will be sent from the device.';
    }
    case 'set_timer': {
      const seconds = parseInt(input.seconds, 10);
      if (!seconds || seconds < 1 || seconds > 24 * 3600) throw new Error('Timer must be between 1 second and 24 hours.');
      actions.push({ type: 'set_timer', seconds, label: input.label ? String(input.label).slice(0, 40) : null });
      return `Queued: ${seconds}-second timer will start on the device.`;
    }
    case 'navigate':
      actions.push({ type: 'navigate', tab: input.tab });
      return 'Queued: switching to the ' + input.tab + ' tab.';
    default:
      throw new Error('Unknown tool ' + name);
  }
}

// ─── Agentic loop (Ollama /api/chat with tool calling) ───────────────────────
const OLLAMA_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function ollamaChat(messages) {
  const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model: MODEL,
    messages,
    tools: OLLAMA_TOOLS,
    stream: false,
    keep_alive: '30m',
    options: { temperature: 0.2, num_predict: 700 },
  }, { timeout: 180000 });
  return r.data?.message || {};
}

// Some models (qwen3 etc.) emit <think>…</think> before the answer.
function cleanReply(s) {
  let out = String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Safety net: small local models occasionally echo the injected "Device
  // context" system block instead of answering. Strip a leaked block if one
  // slips through despite the system-prompt instruction not to.
  out = out.replace(/^\s*\[?Device context\]?:?\s*\n[\s\S]*?(?:\n\s*\n|$)/i, '').trim();
  return out;
}

async function handleCommand(deviceId, text, clientCtx, weatherCity) {
  const actions = [];
  const coords  = /^-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/.test(clientCtx.coords || '') ? clientCtx.coords : null;
  const ctx     = { deviceId, actions, weatherCity, coords };

  const now = new Date();
  const contextLines = [
    `Current date/time: ${now.toDateString()} ${now.toTimeString().slice(0, 5)}`,
    coords ? 'The user\'s location is known - call get_weather WITHOUT a city to use it.'
           : `Default weather city: ${weatherCity}`,
    `Spotify connected: ${!!(devices.get(deviceId)?.tokens?.access_token)}`,
  ];
  if (clientCtx.tab)          contextLines.push(`User is on the "${clientCtx.tab}" tab`);
  if (clientCtx.radioPlaying) contextLines.push('Radio is currently playing on this device');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Device context:\n${contextLines.join('\n')}` },
    { role: 'user',   content: text },
  ];

  let reply = '';
  let lastRoundErrors = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await ollamaChat(messages);
    const toolCalls = msg.tool_calls || [];

    if (!toolCalls.length) {
      reply = cleanReply(msg.content);
      break;
    }

    messages.push(msg);
    lastRoundErrors = [];
    let roundHadSuccess = false;
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      let content;
      try {
        const out = await runTool(name, args, ctx);
        content = typeof out === 'string' ? out : JSON.stringify(out);
        roundHadSuccess = true;
      } catch (e) {
        content = 'Error: ' + String(e.message || e);
        lastRoundErrors.push(String(e.message || e));
      }
      console.log('[assistant] tool:', name, JSON.stringify(args), '→', content.slice(0, 150));
      messages.push({ role: 'tool', tool_name: name, content });
    }
    if (roundHadSuccess) lastRoundErrors = []; // mixed round — trust the model's own summary
  }

  // Small local models occasionally hallucinate a success message even when
  // every tool call in the final round failed. Trust our own (already
  // speakable) error text over that fabrication rather than risk telling the
  // user something happened when it didn't.
  if (lastRoundErrors.length) reply = lastRoundErrors.join(' ');

  return { reply: reply || 'Done.', actions };
}

// ─── Speech-to-text (browser mic audio → ffmpeg → local whisper-server) ─────
function toWav16k(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    const out = [], err = [];
    ff.stdout.on('data', c => out.push(c));
    ff.stderr.on('data', c => err.push(c));
    ff.on('error', reject);
    ff.stdin.on('error', () => {}); // EPIPE if ffmpeg exits early
    ff.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().slice(0, 200)));
    });
    ff.stdin.end(buf);
  });
}

async function transcribe(audioBuf) {
  const wav  = await toWav16k(audioBuf);
  const form = new FormData();
  form.append('file', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('response_format', 'json');
  const r = await axios.post(`${WHISPER_URL}/inference`, form, {
    headers: form.getHeaders(), timeout: 30000, maxBodyLength: Infinity,
  });
  // whisper.cpp marks non-speech as e.g. [BLANK_AUDIO], (wind blowing), *music*
  return String(r.data?.text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Route ────────────────────────────────────────────────────────────────────
function setupAssistantRoutes(app, resolveDevice, weatherCity) {
  app.post('/api/assistant/stt', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'audio body required' });
    try {
      res.json({ text: await transcribe(req.body) });
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND')
        return res.status(503).json({ error: `Speech-to-text engine offline — whisper-server is not running at ${WHISPER_URL}.` });
      res.status(502).json({ error: 'Transcription failed: ' + (e.message || e) });
    }
  });

  app.post('/api/assistant', async (req, res) => {
    const deviceId = resolveDevice(req);
    if (!deviceId) return res.status(400).json({ error: 'device id required' });
    const text = String(req.body?.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'text required' });
    try {
      res.json(await handleCommand(deviceId, text, req.body?.context || {}, weatherCity));
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND')
        return res.status(503).json({ error: `Can't reach Ollama at ${OLLAMA_URL} — is \`ollama serve\` running? Set OLLAMA_URL in .env if it lives elsewhere.` });
      const ollamaErr = e.response?.data?.error;
      if (ollamaErr && /not found/i.test(ollamaErr)) {
        let installed = '';
        try {
          const tags = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 3000 });
          installed = (tags.data.models || []).map(m => m.name).join(', ');
        } catch {}
        return res.status(503).json({ error: `Model "${MODEL}" is not installed — run \`ollama pull ${MODEL}\` or set ASSISTANT_MODEL in .env.` + (installed ? ` Installed models: ${installed}.` : '') });
      }
      if (ollamaErr && /does not support tools/i.test(ollamaErr))
        return res.status(503).json({ error: `Model "${MODEL}" can't do tool calling — use one that can (e.g. llama3.1, qwen2.5, mistral) via ASSISTANT_MODEL in .env.` });
      if (ollamaErr)
        return res.status(502).json({ error: 'Ollama error: ' + ollamaErr });
      console.error('[assistant]', e);
      res.status(500).json({ error: e.message || 'assistant error' });
    }
  });
}

module.exports = setupAssistantRoutes;
module.exports.runTool = runTool;
