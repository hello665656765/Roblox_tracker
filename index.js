const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES) || 1;
const EXTRA_USER_IDS = (process.env.EXTRA_USER_IDS || '')
  .split(',').map(id => id.trim()).filter(Boolean).map(Number);

// ========== SUPABASE ==========
const SUPABASE_URL = 'https://cfcoesccnarwhriuhbem.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_secret_qfjYZ_6QPcZlm_Ldk8S24g_5s_vVcKM';

const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function sb(method, path, body = null) {
  const opts = { method, headers: { ...sbHeaders } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}${path}`, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ========== OFFLINE MILESTONES ==========
const BASE_MILESTONES = [
  { key: '10m', ms: 10 * 60 * 1000, label: '10 minutes' },
  { key: '30m', ms: 30 * 60 * 1000, label: '30 minutes' },
  { key: '1h', ms: 60 * 60 * 1000, label: '1 hour' },
  { key: '3h', ms: 3 * 60 * 60 * 1000, label: '3 hours' },
  { key: '6h', ms: 6 * 60 * 60 * 1000, label: '6 hours' },
  { key: '12h', ms: 12 * 60 * 60 * 1000, label: '12 hours' },
  { key: '1d', ms: 24 * 60 * 60 * 1000, label: '1 day' },
  { key: '3d', ms: 3 * 24 * 60 * 60 * 1000, label: '3 days' },
  { key: '1w', ms: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function getMilestonesUpTo(elapsedMs) {
  const list = [...BASE_MILESTONES];
  let n = 2;
  while (n * WEEK_MS <= elapsedMs) {
    list.push({ key: `${n}w`, ms: n * WEEK_MS, label: `${n} weeks` });
    n++;
  }
  return list;
}

// In-memory cache (loaded from Supabase on start + after every poll)
let data = {
  lastSeen: {},
  friends: {},
  searchedUsers: {},
  logs: [],
  lastPoll: null
};

async function loadFromSupabase() {
  try {
    const users = await sb('GET', '/tracked_users?select=*');
    const logs = await sb('GET', '/logs?select=*&order=timestamp.desc&limit=150');
    const meta = await sb('GET', '/meta?key=eq.lastPoll');

    data.lastSeen = {};
    data.friends = {};
    data.searchedUsers = {};

    for (const u of users || []) {
      data.lastSeen[u.user_id] = {
        history: u.history || [],
        currentlyOnline: u.currently_online || false,
        lastOnline: u.last_online,
        gameId: u.game_id,
        lastStatus: u.last_status,
        offlineSince: u.offline_since,
        milestonesSent: u.milestones_sent || []
      };

      const info = {
        name: u.name,
        username: u.username,
        pfp: u.pfp
      };

      if (u.is_friend) data.friends[u.user_id] = info;
      else data.searchedUsers[u.user_id] = info;
    }

    data.logs = (logs || []).map(l => ({
      type: l.type,
      name: l.name,
      text: l.text,
      timestamp: l.timestamp
    }));

    data.lastPoll = meta?.[0]?.value || null;

    console.log(`Loaded ${users?.length || 0} users and ${data.logs.length} logs from Supabase`);
  } catch (e) {
    console.error('Failed to load from Supabase:', e.message);
  }
}

async function saveUser(uid, entry, info = {}, isFriend = false) {
  const row = {
    user_id: uid,
    name: info.name || null,
    username: info.username || null,
    pfp: info.pfp || null,
    is_friend: isFriend,
    currently_online: entry.currentlyOnline || false,
    last_online: entry.lastOnline || null,
    game_id: entry.gameId || null,
    last_status: entry.lastStatus || null,
    offline_since: entry.offlineSince || null,
    milestones_sent: entry.milestonesSent || [],
    history: entry.history || []
  };

  // Upsert
  await sb('POST', '/tracked_users?on_conflict=user_id', [row]);
}

async function saveLogs(newLogs) {
  if (!newLogs.length) return;
  const rows = newLogs.map(l => ({
    type: l.type,
    name: l.name,
    text: l.text,
    timestamp: l.timestamp
  }));
  await sb('POST', '/logs', rows);
}

async function saveLastPoll(ts) {
  await sb('POST', '/meta?on_conflict=key', [{ key: 'lastPoll', value: ts }]);
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  } catch (e) {}
}

async function robloxFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `.ROBLOSECURITY=${ROBLOSECURITY}`,
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(`Roblox API error ${res.status} - ${url}`);
  return res.json();
}

async function getUserId() {
  const res = await robloxFetch('https://users.roblox.com/v1/users/authenticated');
  return res.id;
}

async function getFriendsIds(userId) {
  const res = await robloxFetch(`https://friends.roblox.com/v1/users/${userId}/friends`);
  return (res.data || []).map(f => f.id);
}

async function getUsersInfo(userIds) {
  if (!userIds.length) return {};
  const res = await robloxFetch('https://users.roblox.com/v1/users', {
    method: 'POST',
    body: JSON.stringify({ userIds, excludeBannedUsers: false })
  });
  const map = {};
  (res.data || []).forEach(u => {
    map[String(u.id)] = {
      name: u.displayName || u.name || String(u.id),
      username: u.name || String(u.id)
    };
  });
  return map;
}

async function getPresences(userIds) {
  if (!userIds.length) return [];
  const res = await robloxFetch('https://presence.roblox.com/v1/presence/users', {
    method: 'POST',
    body: JSON.stringify({ userIds })
  });
  return res.userPresences || [];
}

async function getThumbnails(userIds) {
  const map = {};
  try {
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100).join(',');
      const res = await robloxFetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk}&size=150x150&format=Png&isCircular=false`
      );
      (res.data || []).forEach(t => {
        if (t.imageUrl) map[String(t.targetId)] = t.imageUrl;
      });
    }
  } catch (e) {}
  return map;
}

async function poll() {
  try {
    console.log(`[${new Date().toISOString()}] Polling...`);
    const myId = await getUserId();
    const friendIds = await getFriendsIds(myId);
    const searchedIds = Object.keys(data.searchedUsers).map(Number);
    const allIds = [...new Set([...friendIds, ...searchedIds, ...EXTRA_USER_IDS])];
    if (!allIds.length) return;

    const [infoMap, pfpMap, presences] = await Promise.all([
      getUsersInfo(allIds),
      getThumbnails(allIds),
      getPresences(allIds)
    ]);

    const now = Date.now();
    const newLogs = [];

    // Update friends map
    const friendMap = {};
    friendIds.forEach(id => {
      const uid = String(id);
      const info = infoMap[uid] || {};
      friendMap[uid] = {
        name: info.name || `User ${uid}`,
        username: info.username || uid,
        pfp: pfpMap[uid] || ''
      };
    });
    data.friends = friendMap;

    // Update searched users names/pfps
    for (const uid of Object.keys(data.searchedUsers)) {
      if (infoMap[uid]) {
        data.searchedUsers[uid].name = infoMap[uid].name;
        data.searchedUsers[uid].username = infoMap[uid].username;
      }
      if (pfpMap[uid]) data.searchedUsers[uid].pfp = pfpMap[uid];
    }

    for (const p of presences) {
      const uid = String(p.userId);
      const isOnline = p.userPresenceType !== 0;
      const name = (data.friends[uid]?.name) ||
        (data.searchedUsers[uid]?.name) ||
        (infoMap[uid]?.name) ||
        `User ${uid}`;

      if (!data.lastSeen[uid]) {
        data.lastSeen[uid] = { history: [], currentlyOnline: false, milestonesSent: [] };
      }

      const entry = data.lastSeen[uid];
      const wasOnline = entry.currentlyOnline;
      const prevGameId = entry.gameId;
      const prevLastStatus = entry.lastStatus;

      if (isOnline) {
        entry.currentlyOnline = true;
        entry.lastOnline = now;
        entry.gameId = p.placeId || null;
        entry.lastStatus = p.lastLocation || 'Online';
        entry.offlineSince = null;
        entry.milestonesSent = [];

        if (!wasOnline) {
          newLogs.push({ type: 'online', name, text: 'got online', timestamp: now });
        }
        if (p.placeId && p.placeId !== prevGameId) {
          newLogs.push({ type: 'join_game', name, text: `joined ${p.lastLocation || 'a game'}`, timestamp: now + 1 });
        }
        if (prevGameId && !p.placeId) {
          newLogs.push({ type: 'leave_game', name, text: `left ${prevLastStatus || 'a game'}`, timestamp: now + 1 });
        }
      } else {
        if (wasOnline) {
          if (prevGameId) {
            newLogs.push({ type: 'leave_game', name, text: `left ${entry.lastStatus || 'a game'}`, timestamp: now + 1 });
          }
          entry.history = [
            { went_offline: now, last_location: entry.lastStatus || 'Online' },
            ...(entry.history || [])
          ].slice(0, 10);

          newLogs.push({ type: 'offline', name, text: 'went offline', timestamp: now });
          entry.offlineSince = now;
          entry.milestonesSent = [];
        }

        entry.currentlyOnline = false;
        entry.gameId = null;

        // ===== FIXED MILESTONE LOGIC =====
        if (entry.offlineSince) {
          const elapsed = now - entry.offlineSince;
          const milestones = getMilestonesUpTo(elapsed);
          if (!entry.milestonesSent) entry.milestonesSent = [];

          const lookback = (POLL_INTERVAL_MINUTES * 60 * 1000) + 5000;

          const newlyCrossed = milestones.filter(m =>
            !entry.milestonesSent.includes(m.key) &&
            m.ms > (elapsed - lookback) &&
            m.ms <= elapsed
          );

          for (const m of newlyCrossed) {
            entry.milestonesSent.push(m.key);
            newLogs.push({
              type: 'milestone',
              name,
              text: `has been offline for ${m.label}`,
              timestamp: now
            });
          }

          // Mark older ones as sent so restarts never spam
          for (const m of milestones) {
            if (!entry.milestonesSent.includes(m.key)) {
              entry.milestonesSent.push(m.key);
            }
          }
        }
      }

      // Save this user to Supabase
      const info = data.friends[uid] || data.searchedUsers[uid] || infoMap[uid] || {};
      const isFriend = !!data.friends[uid];
      await saveUser(uid, entry, info, isFriend);
    }

    if (newLogs.length) {
      newLogs.sort((a, b) => {
        if (a.name === b.name) {
          const order = { online: 0, join_game: 1, leave_game: 0, offline: 1, milestone: 2 };
          return (order[a.type] ?? 9) - (order[b.type] ?? 9);
        }
        return b.timestamp - a.timestamp;
      });
      data.logs = [...newLogs, ...(data.logs || [])].slice(0, 150);
      await saveLogs(newLogs);
    }

    data.lastPoll = now;
    await saveLastPoll(now);

    for (const log of newLogs) {
      const msg = `**${log.name}** ${log.text}`;
      console.log(msg);
      await sendDiscord(msg);
    }

    console.log(`Checked ${allIds.length} users | ${newLogs.length} new logs`);
  } catch (err) {
    console.error('Poll failed:', err.message);
  }
}

// ========== API (same as before) ==========
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    lastPoll: data.lastPoll ? new Date(data.lastPoll).toISOString() : null,
    trackedUsers: Object.keys(data.lastSeen).length,
    totalLogs: (data.logs || []).length
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.get('/data', (req, res) => {
  res.json({
    lastSeen: data.lastSeen,
    friends: data.friends,
    searchedUsers: data.searchedUsers,
    logs: data.logs || [],
    lastPoll: data.lastPoll
  });
});

app.post('/search', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.json({ ok: false });

    const searchRes = await robloxFetch(
      `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username)}&limit=10`
    );
    if (!searchRes.data || !searchRes.data.length) return res.json({ ok: false });

    const target = searchRes.data[0];
    const targetId = target.id;
    const uid = String(targetId);

    const [infoMap, pfpMap, presences] = await Promise.all([
      getUsersInfo([targetId]),
      getThumbnails([targetId]),
      getPresences([targetId])
    ]);

    const info = infoMap[uid] || {};
    data.searchedUsers[uid] = {
      name: target.displayName || target.name || info.name || `User ${uid}`,
      username: target.name || info.username || uid,
      pfp: pfpMap[uid] || ''
    };

    if (!data.lastSeen[uid]) data.lastSeen[uid] = { history: [], currentlyOnline: false, milestonesSent: [] };

    const p = presences[0];
    if (p && p.userPresenceType !== 0) {
      data.lastSeen[uid].currentlyOnline = true;
      data.lastSeen[uid].lastOnline = Date.now();
      data.lastSeen[uid].gameId = p.placeId || null;
      data.lastSeen[uid].lastStatus = p.lastLocation || 'Online';
    } else {
      data.lastSeen[uid].currentlyOnline = false;
    }

    await saveUser(uid, data.lastSeen[uid], data.searchedUsers[uid], false);
    res.json({ ok: true });
  } catch (e) {
    console.error('Search failed:', e.message);
    res.json({ ok: false });
  }
});

app.post('/remove', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false });
    const uid = String(userId);
    delete data.searchedUsers[uid];
    delete data.lastSeen[uid];
    await sb('DELETE', `/tracked_users?user_id=eq.${uid}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Start
(async () => {
  await loadFromSupabase();
  setInterval(poll, POLL_INTERVAL_MINUTES * 60 * 1000);
  poll();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Polling every ${POLL_INTERVAL_MINUTES} minutes`);
  });
})();
