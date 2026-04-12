/**
 * Shared test-column parsing and conversion utilities (backend).
 * Keep in sync with frontend parseTestColumn() in dataService.js.
 *
 * Firestore nested format for testScores documents:
 *   {
 *     ROLL_KEY: "GAIL001",
 *     centerCode: "GAIL",
 *     stream: "JEE",        // "JEE" | "NEET"
 *     tests: {
 *       "CAT-1(TEST)": { total: 145, Physics: 45, Chemistry: 52, Math: 48 },
 *       "CMT-2":        { total: 100, Physics: 35, Chemistry: 38, Math: 27 }
 *     }
 *   }
 *
 * Flat in-memory format (used by cache + analytics):
 *   {
 *     ROLL_KEY: "GAIL001",
 *     centerCode: "GAIL",
 *     stream: "JEE",
 *     "CAT-1(TEST)": 145,
 *     "CAT-1(TEST)_Physics": 45,
 *     "CAT-1(TEST)_Chemistry": 52,
 *     "CAT-1(TEST)_Math": 48,
 *   }
 */

const SUBJECT_ALIASES = {
  PHY: 'Physics', PHYSICS: 'Physics',
  CHE: 'Chemistry', CHEM: 'Chemistry', CHEMISTRY: 'Chemistry', CHEMITRY: 'Chemistry',
  MAT: 'Math', MATH: 'Math', MATHS: 'Math', MATHEMATICS: 'Math',
  BIO: 'Biology', BIOLOGY: 'Biology',
  BOT: 'Botany', BOTANY: 'Botany',
  ZOO: 'Zoology', ZOOLOGY: 'Zoology',
};

function normalizeSubject(sub) {
  const token = String(sub || '').trim().toUpperCase();
  if (SUBJECT_ALIASES[token]) return SUBJECT_ALIASES[token];
  if (!sub) return 'Total';
  return sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
}

const RESERVED_KEYS = new Set(['ROLL_KEY', 'ROLL', 'centerCode', 'stream']);

/**
 * Parse a flat test-column key into { testName, subject, isTotal }.
 * Handles:
 *   "CAT-1(TEST)_Physics"  → { testName: "CAT-1(TEST)", subject: "Physics", isTotal: false }
 *   "PHY Test 1"           → { testName: "Test 1",      subject: "Physics", isTotal: false }
 *   "CAT-1(TEST)"          → { testName: "CAT-1(TEST)", subject: "Total",   isTotal: true  }
 */
export function parseTestColumn(col) {
  const raw = String(col || '').trim();

  // New format: CAT-1(TEST)_Physics
  const underscored = raw.match(/^(.+)_([^_]+)$/);
  if (underscored) {
    return { testName: underscored[1].trim(), subject: normalizeSubject(underscored[2]), isTotal: false };
  }

  // Legacy format: PHY Test 1
  const parts = raw.split(/\s+/);
  if (parts.length > 1) {
    const token = (parts[0] || '').toUpperCase();
    if (SUBJECT_ALIASES[token]) {
      return { testName: parts.slice(1).join(' '), subject: SUBJECT_ALIASES[token], isTotal: false };
    }
  }

  // Total column: CAT-1(TEST)
  return { testName: raw, subject: 'Total', isTotal: true };
}

/**
 * Convert a flat test record (from Google Sheets CSV row) → nested Firestore doc.
 */
export function flatToNested(flatRecord) {
  const result = {
    ROLL_KEY:   flatRecord.ROLL_KEY   || '',
    centerCode: flatRecord.centerCode || '',
    stream:     flatRecord.stream     || 'JEE',
    tests:      {},
  };

  for (const [key, value] of Object.entries(flatRecord)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;

    const { testName, subject, isTotal } = parseTestColumn(key);
    if (!result.tests[testName]) result.tests[testName] = {};

    if (isTotal) {
      result.tests[testName].total = value;
    } else {
      result.tests[testName][subject] = value;
    }
  }

  return result;
}

/**
 * Convert a nested Firestore testScores doc → flat in-memory record.
 */
export function nestedToFlat(nestedRecord) {
  const flat = {
    ROLL_KEY:   nestedRecord.ROLL_KEY   || nestedRecord.rollKey || '',
    centerCode: nestedRecord.centerCode || nestedRecord.centreCode || '',
    stream:     nestedRecord.stream     || 'JEE',
  };

  for (const [testName, testData] of Object.entries(nestedRecord.tests || {})) {
    if (!testData || typeof testData !== 'object') continue;
    for (const [key, value] of Object.entries(testData)) {
      if (value === undefined || value === null) continue;
      if (key === 'total' || key === 'Total') {
        flat[testName] = value;
      } else {
        flat[`${testName}_${key}`] = value;
      }
    }
  }

  return flat;
}

/**
 * Extract all test-column names from a nested tests map.
 * Returns both total columns ("CAT-1(TEST)") and subject columns ("CAT-1(TEST)_Physics").
 */
export function extractColumnsFromNestedTests(tests) {
  const cols = new Set();
  for (const [testName, testData] of Object.entries(tests || {})) {
    if (!testData || typeof testData !== 'object') continue;
    cols.add(testName); // total column
    for (const subject of Object.keys(testData)) {
      if (subject !== 'total' && subject !== 'Total') cols.add(`${testName}_${subject}`);
    }
  }
  return Array.from(cols);
}
