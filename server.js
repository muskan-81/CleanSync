/* Smart Waste Management - Express + SQLite backend
   Citizen, Admin and Collector all use this one server, so requests are shared between them. */
const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto'), path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'waste.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- DATABASE SCHEMA (created automatically on first run) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT UNIQUE, name TEXT, email TEXT UNIQUE, mobile TEXT,
  password TEXT, role TEXT CHECK(role IN('citizen','admin','collector')), address TEXT, area TEXT, pincode TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS complaints(id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), waste_type TEXT, problem_type TEXT,
  location TEXT, area TEXT, description TEXT, image TEXT, after_image TEXT, priority TEXT, status TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id TEXT REFERENCES complaints(id),
  collector_id INTEGER REFERENCES users(id), status TEXT, assigned_at INTEGER);
CREATE TABLE IF NOT EXISTS pickup_requests(id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), waste_type TEXT, quantity TEXT,
  location TEXT, preferred_date TEXT, description TEXT, status TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id),
  message TEXT, read_status INTEGER DEFAULT 0, created_at INTEGER);
`);

const SS = ['Submitted', 'Assigned', 'In Progress', 'Awaiting Verification', 'Resolved', 'Reopened'];
const PS = ['Requested', 'Assigned', 'Pickup In Progress', 'Collected', 'Verified'];
const MSG = { Assigned: 'has been assigned to a collector.', 'In Progress': 'cleaning is now in progress.',
  'Awaiting Verification': 'has been marked as resolved. Please verify whether the issue has actually been resolved.',
  Resolved: 'is verified as resolved.', Reopened: 'was reopened - verification required.' };

const note = (uid, m) => db.prepare('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)').run(uid, m, Date.now());
const noteAdmins = m => db.prepare("SELECT id FROM users WHERE role='admin'").all().forEach(a => note(a.id, m));
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');

// Duplicate detection: same location + same problem type, still open
const similar = (c, exceptId = '') => db.prepare(
  "SELECT id FROM complaints WHERE problem_type=? AND lower(trim(location))=? AND status!='Resolved' AND id!=?"
).all(c.prob, String(c.loc).trim().toLowerCase(), exceptId).length;
// Smart priority: simple transparent rules
function priority(c, n) {
  let s = { 'Illegal Dumping': 3, 'Overflowing Bin': 2, 'Missed Collection': 2 }[c.prob] || 1;
  s += c.waste === 'Hazardous' ? 4 : c.waste === 'Mixed' ? 1 : 0;
  if (/school|hospital|college|market/i.test(c.loc)) s += 2;
  s += n >= 2 ? 2 : n >= 1 ? 1 : 0;
  return s >= 6 ? 'CRITICAL' : s >= 4 ? 'HIGH' : s >= 2 ? 'MEDIUM' : 'LOW';
}
const nextId = (table, prefix, start) =>
  prefix + ((db.prepare(`SELECT MAX(CAST(substr(id,3) AS INTEGER)) m FROM ${table}`).get().m || start) + 1);

// ---------- APP + AUTH ----------
const app = express();
// CORS: lets the frontend be opened from another origin (token auth in header, no cookies)
app.use((q, r, n) => {
  r.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' });
  if (q.method === 'OPTIONS') return r.sendStatus(204);
  n();
});
app.use(express.json({ limit: '10mb' }));
// Live updates: every write (POST/PATCH) pings all open browsers/phones, which then reload their data instantly
const clients = new Set();
app.get('/api/events', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  r.flushHeaders(); r.write('retry: 3000\n\n'); clients.add(r); q.on('close', () => clients.delete(r));
});
const broadcast = () => clients.forEach(c => c.write('data: update\n\n'));
setInterval(() => clients.forEach(c => c.write(': ping\n\n')), 25000);
app.use('/api', (q, r, n) => { if (q.method !== 'GET') r.on('finish', broadcast); n(); });
app.get('/api/ping', (q, r) => r.json({ ok: 1 }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = roles => (q, r, n) => {
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(q.headers.authorization || '');
  if (!u) return r.status(401).json({ error: 'Session expired - please login again' });
  if (roles && !roles.includes(u.role)) return r.status(403).json({ error: 'Not allowed for your role' });
  q.user = u; n();
};
const bad = (r, m, c = 400) => r.status(c).json({ error: m });

app.post('/api/register', (q, r) => {
  const b = q.body;
  if (!['citizen', 'admin', 'collector'].includes(b.role) || !b.name || !/^\S+@\S+\.\S+$/.test(b.email || '') || (b.password || '').length < 6) return bad(r, 'Invalid details');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(b.email.toLowerCase())) return bad(r, 'Email already registered', 409);
  const n = db.prepare('SELECT COUNT(*) c FROM users WHERE role=?').get(b.role).c;
  const cid = { citizen: 'CZN', admin: 'ADM', collector: 'COL' }[b.role] + (1001 + n), salt = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO users(cid,name,email,mobile,password,role,address,area,pincode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(cid, b.name, b.email.toLowerCase(), b.mobile, salt + ':' + hash(b.password, salt), b.role, b.address, b.area, b.pincode, Date.now());
  r.json({ cid });
});
app.post('/api/login', (q, r) => {
  const id = String(q.body.id || '').toLowerCase(), u = db.prepare('SELECT * FROM users WHERE email=? OR lower(cid)=?').get(id, id);
  if (!u) return bad(r, 'Invalid email/ID or password', 401);
  const [salt, h] = u.password.split(':');
  if (hash(String(q.body.password || ''), salt) !== h) return bad(r, 'Invalid email/ID or password', 401);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(token, u.id); r.json({ token, role: u.role });
});
app.post('/api/logout', auth(), (q, r) => { db.prepare('DELETE FROM sessions WHERE token=?').run(q.headers.authorization); r.json({ ok: 1 }); });

// Public numbers for the landing page
app.get('/api/public', (q, r) => {
  const t = db.prepare('SELECT COUNT(*) c FROM complaints').get().c, res = db.prepare("SELECT COUNT(*) c FROM complaints WHERE status='Resolved'").get().c;
  r.json({ t, res, pend: t - res, pk: db.prepare('SELECT COUNT(*) c FROM pickup_requests').get().c,
    hs: db.prepare('SELECT COUNT(*) c FROM (SELECT 1 FROM complaints GROUP BY lower(area) HAVING COUNT(*)>=2)').get().c });
});

// Everything the logged-in user is allowed to see (role based)
app.get('/api/state', auth(), (q, r) => {
  const u = q.user, admin = u.role === 'admin';
  const c = db.prepare(`SELECT c.*, (SELECT collector_id FROM assignments WHERE complaint_id=c.id ORDER BY id DESC LIMIT 1) col
                        FROM complaints c ORDER BY created_at DESC`).all().map(x => {
    const mine = admin || x.user_id === u.id || x.col === u.id; // others' photos/descriptions stay private
    return { id: x.id, uid: x.user_id, waste: x.waste_type, prob: x.problem_type, loc: x.location, area: x.area,
      desc: mine ? x.description : '', img: mine ? x.image : '', after: mine ? x.after_image || '' : '',
      pri: x.priority, status: x.status, at: x.created_at, col: x.col || 0, bin: '', log: [] };
  });
  const pk = admin ? db.prepare('SELECT * FROM pickup_requests ORDER BY created_at DESC').all()
    : u.role === 'citizen' ? db.prepare('SELECT * FROM pickup_requests WHERE user_id=? ORDER BY created_at DESC').all(u.id) : [];
  r.json({
    me: { id: u.id, name: u.name, email: u.email, role: u.role, area: u.area, cid: u.cid }, c, b: [],
    p: pk.map(x => ({ id: x.id, uid: x.user_id, waste: x.waste_type, qty: x.quantity, loc: x.location, date: x.preferred_date, desc: x.description, status: x.status })),
    u: admin ? db.prepare("SELECT id,name,'collector' role FROM users WHERE role='collector'").all() : [],
    n: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id).map(x => ({ uid: x.user_id, m: x.message, r: x.read_status, t: x.created_at }))
  });
});

// ---------- COMPLAINTS ----------
app.post('/api/complaints', auth(['citizen']), (q, r) => {
  const b = q.body;
  if (!b.loc || !b.area || (b.desc || '').length < 5) return bad(r, 'Location, area and description are required');
  const n = similar(b), pri = priority(b, n), id = nextId('complaints', 'WM', 1024);
  db.prepare(`INSERT INTO complaints(id,user_id,waste_type,problem_type,location,area,description,image,after_image,priority,status,created_at)
              VALUES(?,?,?,?,?,?,?,?,'',?,'Submitted',?)`).run(id, q.user.id, b.waste, b.prob, b.loc, b.area, b.desc, b.img || '', pri, Date.now());
  noteAdmins(`New complaint ${id} (${pri}) at ${b.loc}`);
  r.json({ id, pri, similar: n });
});
app.patch('/api/complaints/:id', auth(), (q, r) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(q.params.id), u = q.user, b = q.body;
  if (!c) return bad(r, 'Complaint not found', 404);
  const col = (db.prepare('SELECT collector_id FROM assignments WHERE complaint_id=? ORDER BY id DESC').get(c.id) || {}).collector_id;
  const set = (s, m) => { db.prepare('UPDATE complaints SET status=? WHERE id=?').run(s, c.id); if (m) note(c.user_id, `Complaint ${c.id} ${m}`); };
  const deny = () => bad(r, 'Not allowed', 403);
  if (b.action === 'assign') {                       // ADMIN assigns a collector
    if (u.role !== 'admin') return deny();
    const k = db.prepare("SELECT id FROM users WHERE id=? AND role='collector'").get(b.col);
    if (!k) return bad(r, 'Collector not found');
    db.prepare('INSERT INTO assignments(complaint_id,collector_id,status,assigned_at) VALUES(?,?,?,?)').run(c.id, k.id, 'Assigned', Date.now());
    set('Assigned', MSG.Assigned); note(k.id, `New task assigned: ${c.id} at ${c.location}`);
  } else if (b.action === 'status') {                // ADMIN any status, COLLECTOR only "In Progress" on own task
    const ok = u.role === 'admin' || (u.role === 'collector' && col === u.id && b.status === 'In Progress');
    if (!ok || !SS.includes(b.status)) return deny();
    set(b.status, MSG[b.status]);
  } else if (b.action === 'done') {                  // COLLECTOR uploads after-cleanup proof
    if (u.role !== 'collector' || col !== u.id || !b.after) return deny();
    db.prepare('UPDATE complaints SET after_image=? WHERE id=?').run(b.after, c.id);
    set('Awaiting Verification', MSG['Awaiting Verification']);
  } else if (b.action === 'verify') {                // CITIZEN confirms or reopens
    if (u.role !== 'citizen' || c.user_id !== u.id || c.status !== 'Awaiting Verification') return deny();
    set(b.ok ? 'Resolved' : 'Reopened', b.ok ? MSG.Resolved : MSG.Reopened);
    noteAdmins(`Citizen marked ${c.id} as ${b.ok ? 'Resolved' : 'Reopened'}.`);
  } else return bad(r, 'Unknown action');
  r.json({ ok: 1 });
});

// ---------- PICKUPS ----------
app.post('/api/pickups', auth(['citizen']), (q, r) => {
  const b = q.body;
  if (!b.loc || !b.date) return bad(r, 'Location and preferred date are required');
  const id = nextId('pickup_requests', 'PK', 1024);
  db.prepare('INSERT INTO pickup_requests VALUES(?,?,?,?,?,?,?,?,?)').run(id, q.user.id, b.waste, b.qty, b.loc, b.date, b.desc || '', 'Requested', Date.now());
  note(q.user.id, `Your pickup request ${id} is scheduled.`); noteAdmins(`New pickup request ${id}`);
  r.json({ id });
});
app.post('/api/pickups/:id/advance', auth(['admin']), (q, r) => {
  const p = db.prepare('SELECT * FROM pickup_requests WHERE id=?').get(q.params.id);
  if (!p || p.status === 'Verified') return bad(r, 'Cannot advance');
  const s = PS[PS.indexOf(p.status) + 1];
  db.prepare('UPDATE pickup_requests SET status=? WHERE id=?').run(s, p.id); note(p.user_id, `Pickup ${p.id} is now ${s}`);
  r.json({ ok: 1 });
});
app.post('/api/notifications/read', auth(), (q, r) => { db.prepare('UPDATE notifications SET read_status=1 WHERE user_id=?').run(q.user.id); r.json({ ok: 1 }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Waste Management running on http://localhost:${PORT}`);
  const ni = require('os').networkInterfaces();   // show the address to open on a phone (same Wi-Fi)
  for (const k in ni) for (const a of ni[k]) if (a.family === 'IPv4' && !a.internal) console.log(`Phone (same Wi-Fi): http://${a.address}:${PORT}`);
});
