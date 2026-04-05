import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { initializeSheetsPoller, getGlobalData, getCenterData } from './services/googleSheets.js';
import { CENTERS_CONFIG, ADMIN_CREDENTIALS } from './config/centers.js';

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'csrl_super_secret_key_2026';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { role, id, password } = req.body;

  if (role === 'admin') {
    if (id === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
      const token = jwt.sign({ role: 'admin', id: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'admin', name: 'Super Admin' });
    }
  } else if (role === 'centre') {
    const cc = CENTERS_CONFIG[id];
    if (cc && cc.password === password) {
      const token = jwt.sign({ role: 'centre', id }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'centre', name: cc.name });
    }
  } else if (role === 'student') {
    const globalData = getGlobalData();
    const student = globalData.profiles.find(p => p.ROLL_KEY === id || p['ROLL NO.'] === id);
    if (student) {
      const token = jwt.sign({ role: 'student', id: student.ROLL_KEY, centerCode: student.centerCode }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'student', name: student["STUDENT'S NAME"], centerCode: student.centerCode });
    }
  }

  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
  next();
}

// ─── Data Read Routes ─────────────────────────────────────────────────────────

app.get('/api/data/global', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  res.json(getGlobalData());
});

app.get('/api/data/center', authenticateToken, (req, res) => {
  if (req.user.role !== 'centre') return res.status(403).json({ message: 'Forbidden' });
  res.json(getCenterData(req.user.id));
});

app.get('/api/data/student', authenticateToken, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
  const centerData = getCenterData(req.user.centerCode);
  res.json({
    profiles: centerData.profiles.filter(p => p.ROLL_KEY === req.user.id),
    tests: centerData.tests.filter(t => t.ROLL_KEY === req.user.id),
    testColumns: centerData.testColumns
  });
});

// ─── Student CRUD (Admin only) ────────────────────────────────────────────────

// Add a student to the in-memory global cache
app.post('/api/students', authenticateToken, requireAdmin, (req, res) => {
  const globalData = getGlobalData();
  const student = req.body;

  // Basic validation
  if (!student.ROLL_KEY) return res.status(400).json({ message: 'ROLL_KEY is required' });

  // Check for duplicates
  const exists = globalData.profiles.find(p => p.ROLL_KEY === student.ROLL_KEY);
  if (exists) return res.status(409).json({ message: 'Student with this ROLL_KEY already exists' });

  globalData.profiles.push(student);
  console.log(`[CRUD] Added student: ${student.ROLL_KEY}`);
  return res.status(201).json({ success: true, student });
});

// Update a student
app.put('/api/students/:rollKey', authenticateToken, requireAdmin, (req, res) => {
  const globalData = getGlobalData();
  const { rollKey } = req.params;
  const idx = globalData.profiles.findIndex(p => p.ROLL_KEY === rollKey);
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  globalData.profiles[idx] = { ...globalData.profiles[idx], ...req.body, ROLL_KEY: rollKey };
  console.log(`[CRUD] Updated student: ${rollKey}`);
  return res.json({ success: true, student: globalData.profiles[idx] });
});

// Delete a student
app.delete('/api/students/:rollKey', authenticateToken, requireAdmin, (req, res) => {
  const globalData = getGlobalData();
  const { rollKey } = req.params;
  const idx = globalData.profiles.findIndex(p => p.ROLL_KEY === rollKey);
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  globalData.profiles.splice(idx, 1);
  // Also remove test record
  const tIdx = globalData.tests.findIndex(t => t.ROLL_KEY === rollKey);
  if (tIdx !== -1) globalData.tests.splice(tIdx, 1);

  console.log(`[CRUD] Deleted student: ${rollKey}`);
  return res.json({ success: true });
});

// ─── Test Score Upsert (Admin only) ──────────────────────────────────────────

app.post('/api/tests/:rollKey', authenticateToken, requireAdmin, (req, res) => {
  const globalData = getGlobalData();
  const { rollKey } = req.params;
  const { scores } = req.body; // { "PHY Test 1": 85, "CHE Test 1": 72 }

  if (!globalData.profiles.find(p => p.ROLL_KEY === rollKey)) {
    return res.status(404).json({ message: 'Student not found' });
  }

  let testRecord = globalData.tests.find(t => t.ROLL_KEY === rollKey);
  if (!testRecord) {
    testRecord = { ROLL_KEY: rollKey };
    globalData.tests.push(testRecord);
  }

  Object.assign(testRecord, scores);
  console.log(`[CRUD] Upserted test scores for: ${rollKey}`);
  return res.json({ success: true, testRecord });
});

// ─── Server Start ─────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[Server] Core API Backend running on port ${PORT}`);
  await initializeSheetsPoller();
});
