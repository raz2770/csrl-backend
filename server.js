import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { initializeSheetsPoller, getGlobalData, getCenterData } from './services/googleSheets.js';
import { CENTERS_CONFIG, ADMIN_CREDENTIALS } from './config/centers.js';

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'csrl_super_secret_key_2026';

app.use(cors({
  origin: '*'
}));
app.use(express.json());

// Auth Route
app.post('/api/auth/login', (req, res) => {
  const { role, id, password } = req.body;

  if (role === 'admin') {
    if (id === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
      const token = jwt.sign({ role: 'admin', id: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'admin', name: 'Super Admin' });
    }
  } 
  
  else if (role === 'centre') {
    const cc = CENTERS_CONFIG[id];
    if (cc && cc.password === password) {
      const token = jwt.sign({ role: 'centre', id }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'centre', name: cc.name });
    }
  } 
  
  else if (role === 'student') {
    // Check if roll number exists in our global cache!
    const globalData = getGlobalData();
    const student = globalData.profiles.find(p => p.ROLL_KEY === id || p["ROLL NO."] === id);
    if (student) {
      const token = jwt.sign({ role: 'student', id: student.ROLL_KEY, centerCode: student.centerCode }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ success: true, token, role: 'student', name: student["STUDENT'S NAME"], centerCode: student.centerCode });
    }
  }

  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// Middleware
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

// Data Routes
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

app.listen(PORT, async () => {
  console.log(`[Server] Core API Backend running on port ${PORT}`);
  await initializeSheetsPoller();
});
