import './bootstrap-env.js';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { isFirebaseReady } from './services/firebaseInit.js';
import {
  isFirestoreEnabled,
  upsertProfileDoc,
  deleteStudentDocs,
  upsertTestDoc,
  loadApplicationData,
  sliceCenterFromGlobal,
  getReadCacheStatus,
} from './services/firestoreService.js';
import {
  computeOverview,
  rankStudentsByTest,
  absentCount,
  rankCentresByTest,
  computeWeakSubjectAnalysis,
  subjectAverages,
  subjectAveragesForTest,
  buildStudentChartData,
  computeStudentWeakSubject,
  computeTestInsights,
} from './services/analyticsService.js';
import { CENTERS_CONFIG, ADMIN_CREDENTIALS } from './config/centers.js';

const app       = express();
const PORT      = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'csrl_super_secret_key_2026';

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  const global = await loadApplicationData();
  res.json({
    ok: true,
    firebaseReady: isFirebaseReady(),
    firestoreEnabled: isFirestoreEnabled(),
    readCache: getReadCacheStatus(),
    counts: {
      profiles: global.profiles.length,
      tests: global.tests.length,
      testColumns: global.testColumns.length,
    },
  });
});

// ── Profile helpers ────────────────────────────────────────────────────────────

function normalizeRollKey(v) {
  return String(v ?? '').trim().replace(/\.0+$/, '').toUpperCase();
}

function normalizeCenterCode(v) {
  return String(v ?? '').trim().toUpperCase();
}

function findProfileIndex(globalData, rollKey, centerCode) {
  const normalizedRoll = normalizeRollKey(rollKey);
  const normalizedCenter = normalizeCenterCode(centerCode);

  if (centerCode) {
    return globalData.profiles.findIndex(
      (p) =>
        normalizeRollKey(p.ROLL_KEY) === normalizedRoll &&
        normalizeCenterCode(p.centerCode) === normalizedCenter
    );
  }
  const matches = globalData.profiles.filter((p) => normalizeRollKey(p.ROLL_KEY) === normalizedRoll);
  if (matches.length > 1) return -2;
  return globalData.profiles.findIndex((p) => normalizeRollKey(p.ROLL_KEY) === normalizedRoll);
}

function findProfile(globalData, rollKey, centerCode) {
  const idx = findProfileIndex(globalData, rollKey, centerCode);
  if (idx < 0) return null;
  return globalData.profiles[idx];
}

// ── Auth ───────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { role, id, password } = req.body;

  if (role === 'admin') {
    if (id === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
      const token = jwt.sign({ role: 'admin', id: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'admin', id: 'admin', name: 'Super Admin' });
    }
  } else if (role === 'centre') {
    const cc = CENTERS_CONFIG[id];
    if (cc && cc.password === password) {
      const token = jwt.sign({ role: 'centre', id }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'centre', id, centerCode: id, name: cc.name });
    }
  } else if (role === 'student') {
    const globalData = await loadApplicationData();
    const normalizedId = normalizeRollKey(id);
    const student = globalData.profiles.find(
      (p) => normalizeRollKey(p.ROLL_KEY) === normalizedId || normalizeRollKey(p['ROLL NO.']) === normalizedId
    );
    if (student) {
      const token = jwt.sign(
        { role: 'student', id: student.ROLL_KEY, centerCode: student.centerCode },
        JWT_SECRET,
        { expiresIn: '12h' }
      );
      return res.json({
        success: true,
        token,
        role: 'student',
        id: student.ROLL_KEY,
        name: student["STUDENT'S NAME"],
        centerCode: student.centerCode,
        stream: student.stream || 'JEE',
      });
    }
  }

  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// ── Auth Middleware ────────────────────────────────────────────────────────────

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

// ── Data Read Routes ───────────────────────────────────────────────────────────

app.get('/api/data/global', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  res.json(await loadApplicationData());
});

app.get('/api/data/center', authenticateToken, async (req, res) => {
  if (req.user.role !== 'centre') return res.status(403).json({ message: 'Forbidden' });
  const global = await loadApplicationData();
  res.json(sliceCenterFromGlobal(global, req.user.id));
});

app.get('/api/data/student', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ message: 'Forbidden' });
  const global = await loadApplicationData();
  const centerData = sliceCenterFromGlobal(global, req.user.centerCode);
  res.json({
    profiles: centerData.profiles.filter((p) => p.ROLL_KEY === req.user.id),
    tests: centerData.tests.filter((t) => t.ROLL_KEY === req.user.id),
    testColumns: centerData.testColumns,
  });
});

// ── Analytics Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/analytics/overview?centerCode=
 * Returns high-level KPIs. Scoped to a centre if centerCode is provided.
 */
app.get('/api/analytics/overview', authenticateToken, async (req, res) => {
  const { centerCode } = req.query;
  const global = await loadApplicationData();
  const source = centerCode ? sliceCenterFromGlobal(global, centerCode) : global;
  const result = computeOverview(source.profiles, source.tests, source.testColumns);
  res.json(result);
});

/**
 * GET /api/analytics/rankings?testKey=&centerCode=&limit=30&order=desc
 * Rank students by a test column.
 * order=asc returns bottom (lowest scores first).
 */
app.get('/api/analytics/rankings', authenticateToken, async (req, res) => {
  const { testKey, centerCode, limit = '30', order = 'desc' } = req.query;
  if (!testKey) return res.status(400).json({ message: 'testKey is required' });

  const global = await loadApplicationData();
  const source = centerCode ? sliceCenterFromGlobal(global, centerCode) : global;
  let ranked    = rankStudentsByTest(source.profiles, source.tests, testKey);
  const absent  = absentCount(source.profiles, source.tests, testKey);

  if (order === 'asc') ranked = [...ranked].reverse();

  const n = Math.min(parseInt(limit, 10) || 30, ranked.length);
  res.json({
    ranked: ranked.slice(0, n),
    total: ranked.length,
    absentCount: absent,
    testKey,
  });
});

/**
 * GET /api/analytics/centre-leaderboard?testKey=
 * Rank all centres by average score for the given test column.
 */
app.get('/api/analytics/centre-leaderboard', authenticateToken, async (req, res) => {
  const { testKey } = req.query;
  if (!testKey) return res.status(400).json({ message: 'testKey is required' });

  const global = await loadApplicationData();
  const result = rankCentresByTest(global.profiles, global.tests, testKey, global.testColumns);
  res.json(result);
});

/**
 * GET /api/analytics/subject-averages?centerCode=&testKey=
 * Per-subject averages (weakest first). Scoped to a centre if centerCode provided.
 * If testKey is set, only that test’s subject columns are included (not all tests).
 */
app.get('/api/analytics/subject-averages', authenticateToken, async (req, res) => {
  const { centerCode, testKey } = req.query;
  const global = await loadApplicationData();
  const source = centerCode ? sliceCenterFromGlobal(global, centerCode) : global;
  const result = testKey
    ? subjectAveragesForTest(source.tests, source.testColumns, testKey)
    : subjectAverages(source.tests, source.testColumns);
  res.json(result);
});

/**
 * GET /api/analytics/test-insights?testKey=&rollKey=
 * CAT-style analysis (marks-based). Uses global data. Optional rollKey for student card.
 */
app.get('/api/analytics/test-insights', authenticateToken, async (req, res) => {
  const { testKey, rollKey } = req.query;
  if (!testKey) return res.status(400).json({ message: 'testKey is required' });

  const global = await loadApplicationData();
  const result = computeTestInsights(global.profiles, global.tests, testKey, global.testColumns, {
    rollKey: rollKey || undefined,
  });
  res.json(result);
});

/**
 * GET /api/analytics/student-chart?rollKey=&centerCode=
 * Chart-ready performance data for a single student.
 */
app.get('/api/analytics/student-chart', authenticateToken, async (req, res) => {
  const { rollKey, centerCode } = req.query;
  if (!rollKey) return res.status(400).json({ message: 'rollKey is required' });

  const global = await loadApplicationData();
  const source = centerCode ? sliceCenterFromGlobal(global, centerCode) : global;
  const testDoc    = source.tests.find((t) => t.ROLL_KEY === rollKey) || {};
  const chartData  = buildStudentChartData(testDoc, source.testColumns);
  const weakSubj   = computeStudentWeakSubject(testDoc, source.testColumns);

  res.json({ chartData, weakSubject: weakSubj });
});

/**
 * GET /api/analytics/test-columns
 * Return all known test columns and their parsed metadata.
 * Scoped to a centre if centerCode provided.
 */
app.get('/api/analytics/test-columns', authenticateToken, async (req, res) => {
  const { centerCode } = req.query;
  const global = await loadApplicationData();
  const source = centerCode ? sliceCenterFromGlobal(global, centerCode) : global;
  const columns = source.testColumns;

  // Derive unique test names (total columns = no underscore / recognised total)
  const testNames = [...new Set(
    columns
      .filter((c) => !c.includes('_') && !c.match(/^(PHY|CHE|MAT|BIO|BOT|ZOO)\s/i))
      .map((c) => c)
  )];

  res.json({ columns, testNames });
});

// ── Student CRUD (Admin only) ──────────────────────────────────────────────────

app.post('/api/students', authenticateToken, requireAdmin, async (req, res) => {
  const student = req.body;
  if (!student.ROLL_KEY)   return res.status(400).json({ message: 'ROLL_KEY is required' });
  if (!student.centerCode) return res.status(400).json({ message: 'centerCode is required' });

  // Default stream to JEE
  if (!student.stream) student.stream = 'JEE';

  const globalData = await loadApplicationData();
  const exists = globalData.profiles.find(
    (p) => p.centerCode === student.centerCode && p.ROLL_KEY === student.ROLL_KEY
  );
  if (exists) {
    return res.status(409).json({ message: 'Student with this roll already exists at this centre' });
  }

  try {
    if (isFirestoreEnabled()) {
      await upsertProfileDoc(student);
    } else {
      globalData.profiles.push(student);
    }
    const fresh = await loadApplicationData();
    const saved = fresh.profiles.find(
      (p) => p.centerCode === student.centerCode && p.ROLL_KEY === student.ROLL_KEY
    );
    console.log(`[CRUD] Added student: ${student.ROLL_KEY}`);
    return res.status(201).json({ success: true, student: saved });
  } catch (e) {
    console.error('[CRUD] Add student failed:', e);
    return res.status(500).json({ message: e.message || 'Save failed' });
  }
});

app.put('/api/students/:rollKey', authenticateToken, requireAdmin, async (req, res) => {
  const { rollKey }  = req.params;
  const centerCode   = req.query.centerCode;
  const globalData = await loadApplicationData();
  const idx = findProfileIndex(globalData, rollKey, centerCode);

  if (idx === -2) return res.status(400).json({ message: 'Multiple students share this roll; pass centerCode query' });
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  const merged = { ...globalData.profiles[idx], ...req.body, ROLL_KEY: rollKey };

  try {
    if (isFirestoreEnabled()) {
      await upsertProfileDoc(merged);
    } else {
      globalData.profiles[idx] = merged;
    }
    const fresh = await loadApplicationData();
    const updated = fresh.profiles.find(
      (p) => p.ROLL_KEY === rollKey && p.centerCode === merged.centerCode
    );
    console.log(`[CRUD] Updated student: ${rollKey}`);
    return res.json({ success: true, student: updated });
  } catch (e) {
    console.error('[CRUD] Update student failed:', e);
    return res.status(500).json({ message: e.message || 'Update failed' });
  }
});

app.delete('/api/students/:rollKey', authenticateToken, requireAdmin, async (req, res) => {
  const { rollKey } = req.params;
  const centerCode  = req.query.centerCode;
  const globalData = await loadApplicationData();
  const idx = findProfileIndex(globalData, rollKey, centerCode);

  if (idx === -2) return res.status(400).json({ message: 'Multiple students share this roll; pass centerCode query' });
  if (idx === -1) return res.status(404).json({ message: 'Student not found' });

  const cc = globalData.profiles[idx].centerCode;

  try {
    if (isFirestoreEnabled()) {
      await deleteStudentDocs(cc, rollKey);
    } else {
      globalData.profiles.splice(idx, 1);
      const tIdx = globalData.tests.findIndex(
        (t) => t.ROLL_KEY === rollKey && t.centerCode === cc
      );
      if (tIdx !== -1) globalData.tests.splice(tIdx, 1);
    }
    console.log(`[CRUD] Deleted student: ${rollKey}`);
    return res.json({ success: true });
  } catch (e) {
    console.error('[CRUD] Delete student failed:', e);
    return res.status(500).json({ message: e.message || 'Delete failed' });
  }
});

// ── Test Score Upsert (Admin only) ────────────────────────────────────────────

/**
 * POST /api/tests/:rollKey?centerCode=
 * Body can be:
 *   { scores: { "CAT-1(TEST)_Physics": 45, "CAT-1(TEST)": 145, ... } }  (flat)
 *   { scores: { tests: { "CAT-1(TEST)": { Physics: 45, total: 145 } } } } (nested patch)
 */
app.post('/api/tests/:rollKey', authenticateToken, requireAdmin, async (req, res) => {
  const { rollKey }  = req.params;
  const centerCode   = req.query.centerCode;
  const { scores }   = req.body;

  const globalData = await loadApplicationData();
  const profile = findProfile(globalData, rollKey, centerCode);

  if (!profile) {
    if (!centerCode && globalData.profiles.filter((p) => normalizeRollKey(p.ROLL_KEY) === normalizeRollKey(rollKey)).length > 1) {
      return res.status(400).json({ message: 'Multiple students share this roll; pass centerCode query' });
    }
    return res.status(404).json({ message: 'Student not found' });
  }

  const cc = profile.centerCode;

  try {
    if (isFirestoreEnabled()) {
      const testRecord = await upsertTestDoc(cc, rollKey, scores);
      console.log(`[CRUD] Upserted test scores for: ${rollKey}`);
      return res.json({ success: true, testRecord });
    }

    // In-memory fallback
    let testRecord = globalData.tests.find(
      (t) => t.ROLL_KEY === rollKey && t.centerCode === cc
    );
    if (!testRecord) {
      testRecord = { ROLL_KEY: rollKey, centerCode: cc };
      globalData.tests.push(testRecord);
    }
    Object.assign(testRecord, scores);
    console.log(`[CRUD] Upserted test scores for: ${rollKey}`);
    return res.json({ success: true, testRecord });
  } catch (e) {
    console.error('[CRUD] Test upsert failed:', e);
    return res.status(500).json({ message: e.message || 'Save failed' });
  }
});

// ── Errors (async route failures + thrown errors) ─────────────────────────────

app.use((err, req, res, next) => {
  void next;
  console.error('[API]', req.method, req.path, err);
  const status = Number(err.statusCode || err.status) || 500;
  const message =
    err.message ||
    (status === 500 ? 'Internal Server Error' : 'Request failed');
  res.status(status).json({
    message,
    ...(process.env.NODE_ENV !== 'production' && err.stack ? { detail: err.stack } : {}),
  });
});

// ── Server Start ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Core API Backend running on port ${PORT}`);
});
