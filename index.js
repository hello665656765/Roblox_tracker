const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIG (set these in Render Environment Variables) ============
const ROBLOSECURITY = process.env.ROBLOSECURITY;           // your .ROBLOSECURITY cookie
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || ''; // optional
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES) || 2;
const EXTRA_USER_IDS = (process.env.EXTRA_USER_IDS || '')  // comma-separated IDs
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(Number);

// ============================================================================

const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_HISTORY = 10;

let data = {
  lastSeen: {},
  friends: {},
  searchedUsers: {}
};

// Load previous data if it exists
if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load data.json', e);
  }
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
  } catch (e) {
    console.error('Discord webhook failed', e.message);
  }
}

async function robloxFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `.ROBLOSECURITY=${ROBLOSECURITY}`,
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    throw new Error(`Roblox API error ${res.status} - ${url}`);
  }
  return res.json();
}

async function getUserId() {
  const data = await robloxFetch('https://users.roblox.com/v1/users/authenticated');
  return data.id;
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

async function poll() {
  try {
    console.log(`[${new Date().toISOString()}] Polling...`);

    const myId = await getUserId();
    const friendIds = await getFriendsIds(myId);
    const allIds = [...new Set([...friendIds, ...EXTRA_USER_IDS])];

    if (!allIds.length) {
      console.log('No users to track');
      return;
    }

    const [infoMap, presences] = await Promise.all([
      getUsersInfo(allIds),
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
        username: info.username || uid
      };
    });
    data.friends = friendMap;

    // Process presences
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

        if (!wasOnline) {
          newLogs.push({ type: 'online', name, text: 'just came online' });
        }
        if (p.placeId && p.placeId !== prevGameId) {
          newLogs.push({ type: 'game', name, text: `joined ${p.lastLocation || 'a game'}` });
        }
      } else {
        if (wasOnline) {
          entry.history = [
            { went_offline: now, last_location: entry.lastStatus || 'Online' },
            ...(entry.history || [])
          ].slice(0, MAX_HISTORY);

          newLogs.push({ type: 'offline', name, text: 'went offline' });
        }
        entry.currentlyOnline = false;
      }
    }

    data.lastPoll = now;
    saveData();

    // Send notifications
    for (const log of newLogs) {
      const msg = `**${log.name}** ${log.text}`;
      console.log(msg);
      await sendDiscord(msg);
    }

    console.log(`Checked ${allIds.length} users | ${newLogs.length} events`);
  } catch (err) {
    console.error('Poll failed:', err.message);
  }
}

// Start polling
setInterval(poll, POLL_INTERVAL_MINUTES * 60 * 1000);
poll(); // run once immediately

// Simple web server (needed for free Render plan + keep-alive)
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    lastPoll: data.lastPoll ? new Date(data.lastPoll).toISOString() : null,
    trackedUsers: Object.keys(data.lastSeen).length
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Polling every ${POLL_INTERVAL_MINUTES} minutes`);
});
