const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
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

const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_HISTORY = 10;
const MAX_LOGS = 150;

let data = {
  lastSeen: {},
  friends: {},
  searchedUsers: {},
  logs: [],
  lastPoll: null
};

if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

    // Update friends
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

    // Update searched users
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
        data.lastSeen[uid] = { history: [], currentlyOnline: false };
      }

      const entry = data.lastSeen[uid];
      const wasOnline = entry.currentlyOnline;
      const prevGameId = entry.gameId;

      if (isOnline) {
        entry.currentlyOnline = true;
        entry.lastOnline = now;
        entry.gameId = p.placeId || null;
        entry.lastStatus = p.lastLocation || 'Online';

        // came online
        if (!wasOnline) {
          newLogs.push({
            type: 'online',
            name,
            text: 'got online',
            timestamp: now
          });
        }

        // joined a game
        if (p.placeId && p.placeId !== prevGameId) {
          newLogs.push({
            type: 'game',
            name,
            text: `joined ${p.lastLocation || 'a game'}`,
            timestamp: now + 1
          });
        }

        // left a game (was in a game, now no longer in one)
        if (prevGameId && !p.placeId) {
          newLogs.push({
            type: 'game',
            name,
            text: 'left a game',
            timestamp: now + 1
          });
        }
      } else {
        // went offline
                // went offline
        if (wasOnline) {
          // leave game first (newer timestamp so it appears above offline)
          if (prevGameId) {
            newLogs.push({
              type: 'game',
              name,
              text: 'left a game',
              timestamp: now + 1
            });
          }
          entry.history = [
            { went_offline: now, last_location: entry.lastStatus || 'Online' },
            ...(entry.history || [])
          ].slice(0, MAX_HISTORY);
          newLogs.push({
            type: 'offline',
            name,
            text: 'went offline',
            timestamp: now
          });
        }
        entry.currentlyOnline = false;
        entry.gameId = null;
      }
    }

    // Stable order: game → online → offline for same user, then by time
    if (newLogs.length) {
      newLogs.sort((a, b) => {
        if (a.name === b.name) {
          const order = { game: 0, online: 1, offline: 2 };
          return (order[a.type] ?? 9) - (order[b.type] ?? 9);
        }
        return b.timestamp - a.timestamp;
      });
      data.logs = [...newLogs, ...(data.logs || [])].slice(0, MAX_LOGS);
    }

    data.lastPoll = now;
    saveData();

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

setInterval(poll, POLL_INTERVAL_MINUTES * 60 * 1000);
poll();

// ========== API ==========
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
    if (!searchRes.data || !searchRes.data.length) {
      return res.json({ ok: false });
    }

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

    const p = presences[0];
    if (p && p.userPresenceType !== 0) {
      if (!data.lastSeen[uid]) data.lastSeen[uid] = { history: [], currentlyOnline: false };
      data.lastSeen[uid].currentlyOnline = true;
      data.lastSeen[uid].lastOnline = Date.now();
      data.lastSeen[uid].gameId = p.placeId || null;
      data.lastSeen[uid].lastStatus = p.lastLocation || 'Online';
    } else {
      if (data.lastSeen[uid]) {
        data.lastSeen[uid].currentlyOnline = false;
      }
    }

    saveData();
    res.json({ ok: true });
  } catch (e) {
    console.error('Search failed:', e.message);
    res.json({ ok: false });
  }
});

app.post('/remove', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false });
    const uid = String(userId);
    delete data.searchedUsers[uid];
    delete data.lastSeen[uid];
    saveData();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Polling every ${POLL_INTERVAL_MINUTES} minutes`);
});
