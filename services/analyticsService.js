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
 * Per-subject averages for one test only (columns whose parsed testName matches testKey).
 */
export function computeWeakSubjectAnalysisForTest(tests, testColumns, testKey) {
  if (!testKey) return [];
  const totals = {};
  const counts = {};

  tests.forEach((t) => {
    (testColumns || []).forEach((col) => {
      const { subject, isTotal, testName } = parseTestColumn(col);
      if (isTotal || subject === 'Total') return;
      if (testName !== testKey) return;
      const mark = numericScore(t[col]);
      if (mark === null) return;
      totals[subject] = (totals[subject] || 0) + mark;
      counts[subject] = (counts[subject] || 0) + 1;
    });
  });

  return Object.keys(totals)
    .map((sub) => ({
      subject: sub,
      avg: parseFloat((totals[sub] / counts[sub]).toFixed(1)),
      count: counts[sub],
    }))
    .sort((a, b) => a.avg - b.avg);
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
 * Returns [{ subject, avg, count }] sorted ascending by avg (weakest subject first).
 */
export function subjectAverages(tests, testColumns) {
  return computeWeakSubjectAnalysis(tests, testColumns);
}

/** Per-subject averages scoped to a single test (total column key). */
export function subjectAveragesForTest(tests, testColumns, testKey) {
  return computeWeakSubjectAnalysisForTest(tests, testColumns, testKey);
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

function streamCaps(stream) {
  const s = stream === 'NEET' ? 'NEET' : 'JEE';
  return { maxPerSubject: 60, maxTotal: 180, stream: s };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * CAT-style analysis for one test (total column key), from stored marks only.
 * Qualification uses configurable % of max total / max per-subject marks (not attempt counts).
 */
export function computeTestInsights(profiles, tests, testKey, testColumns, options = {}) {
  const overallQualifyRatio = options.overallQualifyRatio ?? 0.4;
  const subjectQualifyRatio = options.subjectQualifyRatio ?? 0.35;
  const rollKeyFilter = options.rollKey || null;

  if (!testKey) {
    return {
      error: 'testKey is required',
      testKey: null,
      subjects: [],
      cutoffs: null,
      overallTopper: null,
      bestScorePercentStudent: null,
      top10: [],
      top10CentreCounts: {},
      globalSubjectStats: [],
      weakestSubjectByScorePercent: null,
      centreRows: [],
      bottom5Centres: [],
      notQualifiedOverall: {},
      notQualifiedBySubject: {},
      qualificationRateByCentre: [],
      studentInsight: null,
      note: null,
    };
  }

  const subjectCols = (testColumns || []).filter((col) => {
    const p = parseTestColumn(col);
    return !p.isTotal && p.testName === testKey;
  });

  const subjects = [...new Set(subjectCols.map((c) => parseTestColumn(c).subject))];

  const ranked = rankStudentsByTest(profiles, tests, testKey);

  const overallTopper = ranked.length
    ? {
        roll: ranked[0].roll,
        name: ranked[0].name,
        center: ranked[0].center || '—',
        total: ranked[0].marks,
        stream: ranked[0].stream || 'JEE',
      }
    : null;

  let bestScorePercentStudent = null;
  let bestPct = -1;
  profiles.forEach((p) => {
    const doc = tests.find((t) => t.ROLL_KEY === p.ROLL_KEY);
    if (!doc) return;
    const t = numericScore(doc[testKey]);
    if (t === null) return;
    const stream = p.stream || doc.stream || 'JEE';
    const { maxTotal } = streamCaps(stream);
    const pct = (t / maxTotal) * 100;
    if (pct > bestPct) {
      bestPct = pct;
      bestScorePercentStudent = {
        roll: p.ROLL_KEY,
        name: p["STUDENT'S NAME"] || '',
        center: p.centerCode || '—',
        total: t,
        scorePercent: round2(pct),
        stream,
      };
    }
  });

  const top10 = ranked.slice(0, 10);
  const top10CentreCounts = {};
  top10.forEach((s) => {
    const c = s.center || 'UNKNOWN';
    top10CentreCounts[c] = (top10CentreCounts[c] || 0) + 1;
  });

  /** @type {Array<{ roll: string, center: string, appeared: boolean, qualified: boolean, total: number|null, subjectScores: Record<string, number|null> }>} */
  const studentStates = [];

  profiles.forEach((p) => {
    const doc = tests.find((t) => t.ROLL_KEY === p.ROLL_KEY);
    const stream = p.stream || doc?.stream || 'JEE';
    const { maxPerSubject, maxTotal } = streamCaps(stream);
    const overallMin = maxTotal * overallQualifyRatio;
    const subjectMin = maxPerSubject * subjectQualifyRatio;

    const subjectScores = {};
    subjectCols.forEach((col) => {
      const subj = parseTestColumn(col).subject;
      subjectScores[subj] = doc ? numericScore(doc[col]) : null;
    });

    if (!doc) {
      studentStates.push({
        roll: p.ROLL_KEY,
        center: p.centerCode || 'UNKNOWN',
        appeared: false,
        qualified: false,
        total: null,
        subjectScores,
        overallMin,
        subjectMin,
      });
      return;
    }

    const total = numericScore(doc[testKey]);
    const appeared =
      total !== null ||
      Object.values(subjectScores).some((v) => v !== null && v !== undefined);

    if (!appeared) {
      studentStates.push({
        roll: p.ROLL_KEY,
        center: p.centerCode || 'UNKNOWN',
        appeared: false,
        qualified: false,
        total,
        subjectScores,
        overallMin,
        subjectMin,
      });
      return;
    }

    let qualified = total !== null && total >= overallMin;
    if (qualified) {
      for (const col of subjectCols) {
        const subj = parseTestColumn(col).subject;
        const m = numericScore(doc[col]);
        if (m !== null && m < subjectMin) qualified = false;
      }
    } else {
      qualified = false;
    }

    studentStates.push({
      roll: p.ROLL_KEY,
      center: p.centerCode || 'UNKNOWN',
      appeared: true,
      qualified,
      total,
      subjectScores,
      overallMin,
      subjectMin,
    });
  });

  const notQualifiedOverall = {};
  const notQualifiedBySubject = {};
  subjects.forEach((subj) => {
    notQualifiedBySubject[subj] = {};
  });

  studentStates.forEach((st) => {
    if (!st.appeared || st.qualified) return;
    const c = st.center;
    notQualifiedOverall[c] = (notQualifiedOverall[c] || 0) + 1;
  });

  studentStates.forEach((st) => {
    if (!st.appeared) return;
    subjects.forEach((subj) => {
      const m = st.subjectScores[subj];
      const smin = st.subjectMin;
      if (m !== null && m < smin) {
        const c = st.center;
        notQualifiedBySubject[subj][c] = (notQualifiedBySubject[subj][c] || 0) + 1;
      }
    });
  });

  const byCentre = {};
  studentStates.forEach((st) => {
    if (!st.appeared) return;
    const c = st.center;
    if (!byCentre[c]) {
      byCentre[c] = { appeared: 0, qualified: 0, totals: [], subjectMarks: {} };
    }
    byCentre[c].appeared += 1;
    if (st.qualified) byCentre[c].qualified += 1;
    if (st.total !== null) byCentre[c].totals.push(st.total);
    subjects.forEach((subj) => {
      const m = st.subjectScores[subj];
      if (m !== null) {
        if (!byCentre[c].subjectMarks[subj]) byCentre[c].subjectMarks[subj] = [];
        byCentre[c].subjectMarks[subj].push(m);
      }
    });
  });

  const centreRows = Object.entries(byCentre)
    .map(([code, agg]) => {
      const totalAvg = agg.totals.length
        ? agg.totals.reduce((a, b) => a + b, 0) / agg.totals.length
        : 0;
      const subjectAvgs = {};
      subjects.forEach((subj) => {
        const arr = agg.subjectMarks[subj] || [];
        subjectAvgs[subj] = arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      });
      const qualRate = agg.appeared ? round2((agg.qualified / agg.appeared) * 100) : 0;
      return {
        code,
        appeared: agg.appeared,
        qualified: agg.qualified,
        qualRate,
        totalAvg: round2(totalAvg),
        subjectAvgs,
      };
    })
    .sort((a, b) => b.totalAvg - a.totalAvg)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  const bottom5Centres =
    centreRows.length <= 5 ? [...centreRows].reverse() : centreRows.slice(-5).reverse();

  const globalMarks = {};
  const globalCounts = {};
  subjects.forEach((subj) => {
    globalMarks[subj] = 0;
    globalCounts[subj] = 0;
  });

  studentStates.forEach((st) => {
    if (!st.appeared) return;
    subjects.forEach((subj) => {
      const m = st.subjectScores[subj];
      if (m !== null) {
        globalMarks[subj] += m;
        globalCounts[subj] += 1;
      }
    });
  });

  const globalSubjectStats = subjects.map((subj) => {
    const n = globalCounts[subj];
    const avgMarks = n ? globalMarks[subj] / n : 0;
    const scorePercentOfMax = round2((avgMarks / 60) * 100);
    return {
      subject: subj,
      avgMarks: round2(avgMarks),
      scorePercentOfMax,
      studentCount: n,
    };
  });

  globalSubjectStats.sort((a, b) => a.scorePercentOfMax - b.scorePercentOfMax);
  const weakestSubjectByScorePercent = globalSubjectStats.length ? globalSubjectStats[0].subject : null;

  const qualificationRateByCentre = [...centreRows]
    .sort((a, b) => a.qualRate - b.qualRate)
    .slice(0, 12);

  const { maxTotal, maxPerSubject } = streamCaps('JEE');
  const cutoffs = {
    overallMin: round2(maxTotal * overallQualifyRatio),
    subjectMin: round2(maxPerSubject * subjectQualifyRatio),
    overallQualifyRatio,
    subjectQualifyRatio,
    maxTotal,
    maxPerSubject,
  };

  let studentInsight = null;
  if (rollKeyFilter) {
    const idx = ranked.findIndex((r) => r.roll === rollKeyFilter);
    const st = studentStates.find((s) => s.roll === rollKeyFilter);
    studentInsight = {
      roll: rollKeyFilter,
      rank: idx >= 0 ? idx + 1 : null,
      total: st?.total ?? null,
      qualified: !!st?.qualified,
      appeared: !!st?.appeared,
      subjectScores: st?.subjectScores ?? {},
      totalStudentsRanked: ranked.length,
    };
  }

  return {
    testKey,
    subjects,
    cutoffs,
    overallTopper,
    bestScorePercentStudent,
    top10,
    top10CentreCounts,
    globalSubjectStats,
    weakestSubjectByScorePercent,
    centreRows,
    bottom5Centres,
    notQualifiedOverall,
    notQualifiedBySubject,
    qualificationRateByCentre,
    studentInsight,
    note:
      'Based on stored marks only. “Score %” is marks as a percentage of max (60 per subject, 180 total). Qualification uses default cutoffs (40% of total, 35% per subject). Attempt accuracy is not stored in this system.',
  };
}
