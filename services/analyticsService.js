/**
 * Backend analytics service.
 * All heavy computation lives here so the frontend only renders — never computes.
 */

import { parseTestColumn } from '../utils/testColumns.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasUsableScore(v) {
  return v !== undefined && v !== null && v !== '' && String(v).toLowerCase() !== 'absent';
}

function numericScore(v) {
  if (!hasUsableScore(v)) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/**
 * Get the JEE / NEET exam percentile stored on a profile.
 * Looks for any key containing "percentile" (case-insensitive).
 */
export function getExamPercentile(profile) {
  if (!profile) return null;
  const key = Object.keys(profile).find(
    (k) =>
      k.toLowerCase().includes('percentile') ||
      (k.toLowerCase().includes('jee') && k.toLowerCase().includes('main')) ||
      k.toLowerCase().includes('neet')
  );
  return key ? profile[key] : null;
}

// ── Core analytics ────────────────────────────────────────────────────────────

/**
 * Overview KPIs for a set of profiles + tests.
 * Returns { totalStudents, activeTestCount, weakSubject, avgPercentile, highestPercentile }
 */
export function computeOverview(profiles, tests, testColumns) {
  const totalStudents = profiles.length;
  const activeTestCount = tests.length;

  // Percentile stats (JEE / NEET)
  let sum = 0, count = 0, highest = 0;
  profiles.forEach((p) => {
    const pct = parseFloat(getExamPercentile(p));
    if (!isNaN(pct)) {
      sum += pct;
      count++;
      if (pct > highest) highest = pct;
    }
  });

  const weakAnalysis = computeWeakSubjectAnalysis(tests, testColumns);
  const weakSubject = weakAnalysis.length ? weakAnalysis[0].subject : 'N/A';

  return {
    totalStudents,
    activeTestCount,
    weakSubject,
    avgPercentile:     count > 0 ? parseFloat((sum / count).toFixed(2)) : null,
    highestPercentile: count > 0 ? parseFloat(highest.toFixed(2)) : null,
  };
}

/**
 * Rank students by a single test column.
 * Returns array sorted descending by score: [{ rank, roll, name, marks, center, category }]
 */
export function rankStudentsByTest(profiles, tests, testKey) {
  if (!testKey) return [];

  const scored = [];
  profiles.forEach((p) => {
    const testDoc = tests.find((t) => t.ROLL_KEY === p.ROLL_KEY);
    if (!testDoc) return;
    const mark = numericScore(testDoc[testKey]);
    if (mark === null) return;
    scored.push({
      roll:     p.ROLL_KEY,
      name:     p["STUDENT'S NAME"] || '',
      marks:    mark,
      center:   p.centerCode || '',
      category: p.CATEGORY   || '',
      stream:   p.stream     || testDoc.stream || 'JEE',
      photo:    p['STUDENT PHOTO URL'] || null,
    });
  });

  scored.sort((a, b) =>
    b.marks !== a.marks ? b.marks - a.marks : a.roll.localeCompare(b.roll)
  );
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * Absent count for a test key across a set of profiles.
 */
export function absentCount(profiles, tests, testKey) {
  return profiles.filter((p) => {
    const doc = tests.find((t) => t.ROLL_KEY === p.ROLL_KEY);
    if (!doc) return false;
    const v = doc[testKey];
    return !v || String(v).toLowerCase() === 'absent';
  }).length;
}

/**
 * Per-subject average scores across all tests.
 * Returns [{ subject, avg, count }] sorted descending by avg.
 */
export function computeWeakSubjectAnalysis(tests, testColumns) {
  const totals = {};
  const counts = {};

  tests.forEach((t) => {
    (testColumns || []).forEach((col) => {
      const { subject, isTotal } = parseTestColumn(col);
      if (isTotal || subject === 'Total') return;
      const mark = numericScore(t[col]);
      if (mark === null) return;
      totals[subject] = (totals[subject] || 0) + mark;
      counts[subject] = (counts[subject] || 0) + 1;
    });
  });

  return Object.keys(totals)
    .map((sub) => ({
      subject: sub,
      avg:     parseFloat((totals[sub] / counts[sub]).toFixed(1)),
      count:   counts[sub],
    }))
    .sort((a, b) => a.avg - b.avg); // ascending: weakest first
}

/**
 * Rank centres by average score for a single test column.
 * Returns [{ rank, code, avg, top, tested, studentCount, weakSubject }]
 */
export function rankCentresByTest(profiles, tests, testKey, testColumns) {
  if (!testKey || !profiles.length) return [];

  const centreAgg = {};

  profiles.forEach((p) => {
    const code = p.centerCode || 'UNKNOWN';
    const doc  = tests.find((t) => t.ROLL_KEY === p.ROLL_KEY);

    if (!centreAgg[code]) centreAgg[code] = { sum: 0, count: 0, max: -Infinity, studentCount: 0 };
    centreAgg[code].studentCount++;

    if (!doc) return;
    const mark = numericScore(doc[testKey]);
    if (mark === null) return;
    centreAgg[code].sum   += mark;
    centreAgg[code].count += 1;
    if (mark > centreAgg[code].max) centreAgg[code].max = mark;
  });

  return Object.entries(centreAgg)
    .filter(([, s]) => s.count > 0)
    .map(([code, s]) => {
      const avg     = s.count ? Math.round(s.sum / s.count) : 0;
      const top     = s.max === -Infinity ? 0 : s.max;
      const rollSet = new Set(
        profiles.filter((p) => (p.centerCode || 'UNKNOWN') === code).map((p) => p.ROLL_KEY)
      );
      const centreTests    = tests.filter((t) => rollSet.has(t.ROLL_KEY));
      const weakAnalysis   = computeWeakSubjectAnalysis(centreTests, testColumns);
      const weakSubject    = weakAnalysis.length ? weakAnalysis[0].subject : 'N/A';
      return { code, avg, top, tested: s.count, studentCount: s.studentCount, weakSubject };
    })
    .sort((a, b) => b.avg - a.avg)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/**
 * Per-subject averages for a set of tests (used for trend/breakdown charts).
 * Returns [{ subject, avg, count }] sorted descending by avg.
 */
export function subjectAverages(tests, testColumns) {
  return computeWeakSubjectAnalysis(tests, testColumns)
    .sort((a, b) => b.avg - a.avg); // descending for display
}

/**
 * Build chart-ready data for a single student.
 * Returns [{ name: testName, Physics: 45, Chemistry: 52, Math: 48, Total: 145 }] sorted by test name.
 */
export function buildStudentChartData(studentTestFlat, testColumns) {
  const testsMap = {};

  (testColumns || []).forEach((col) => {
    const { subject, testName, isTotal } = parseTestColumn(col);
    if (!testsMap[testName]) testsMap[testName] = { name: testName };

    const raw = studentTestFlat[col];
    if (hasUsableScore(raw)) {
      const m = parseFloat(raw);
      if (!isNaN(m)) testsMap[testName][subject] = m;
    } else {
      testsMap[testName][subject] = null;
    }

    // Derive total if no explicit total column
    if (!isTotal && testsMap[testName].Total === undefined) {
      const vals = Object.entries(testsMap[testName])
        .filter(([k, v]) => k !== 'name' && k !== 'Total' && typeof v === 'number');
      testsMap[testName].Total = vals.length ? vals.reduce((s, [, v]) => s + v, 0) : null;
    }
  });

  return Object.values(testsMap).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

/**
 * Compute weakest subject for a single student from their flat test record.
 * Returns the subject name string, or "N/A".
 */
export function computeStudentWeakSubject(studentTestFlat, testColumns) {
  const totals = {};
  const counts = {};

  (testColumns || []).forEach((col) => {
    const { subject, isTotal } = parseTestColumn(col);
    if (isTotal || subject === 'Total') return;
    const mark = numericScore(studentTestFlat[col]);
    if (mark === null) return;
    totals[subject] = (totals[subject] || 0) + mark;
    counts[subject] = (counts[subject] || 0) + 1;
  });

  if (!Object.keys(totals).length) return 'N/A';
  return Object.entries(totals)
    .map(([sub, total]) => ({ sub, avg: total / (counts[sub] || 1) }))
    .sort((a, b) => a.avg - b.avg)[0].sub;
}
