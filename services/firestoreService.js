import { getFirestore } from 'firebase-admin/firestore';
import { initFirebaseApp } from './firebaseInit.js';
import { flatToNested, nestedToFlat, extractColumnsFromNestedTests } from '../utils/testColumns.js';

const COL_PROFILES = 'students';
const COL_TESTS    = 'testScores'; // renamed from 'tests' for clarity

const BATCH_LIMIT = 450;

/** In-memory read cache: full collection scans are expensive; TTL reduces Firestore read quota usage. */
let firestoreReadCache = { data: null, expiresAt: 0 };

function readCacheTtlMs() {
  const raw = process.env.FIRESTORE_READ_CACHE_TTL_MS;
  if (raw === '0' || raw === '') return 0;
  const n = parseInt(raw ?? '90000', 10);
  return Number.isFinite(n) && n >= 0 ? n : 90000;
}

/** Call after any write so the next load sees fresh data (or bump expiry). */
export function invalidateFirestoreReadCache() {
  firestoreReadCache = { data: null, expiresAt: 0 };
}

export function isFirestoreEnabled() {
  return initFirebaseApp();
}

export function makeDocId(centerCode, rollKey) {
  void centerCode;
  const r = String(rollKey ?? '').trim().replace(/\//g, '_');
  // Keep IDs compatible with migration scripts that use roll-key doc ids.
  return r;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function commitBatches(writes) {
  const db = getFirestore();
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const { ref, data, merge } of writes.slice(i, i + BATCH_LIMIT)) {
      batch.set(ref, data, { merge: merge ?? false });
    }
    await batch.commit();
  }
}

// ── Schema migration: flat legacy doc → nested ─────────────────────────────

/**
 * Detect whether a Firestore test doc is already in the new nested format.
 * New format has a `tests` map; old format has flat score keys.
 */
function isNestedFormat(doc) {
  return doc && typeof doc.tests === 'object' && doc.tests !== null;
}

/**
 * Ensure a raw Firestore test doc is returned in nested format.
 * Handles both old flat docs (migration path) and new nested docs.
 */
function ensureNested(rawDoc) {
  if (!rawDoc) return rawDoc;
  if (isNestedFormat(rawDoc)) {
    const normalized = {
      ...rawDoc,
      ROLL_KEY: rawDoc.ROLL_KEY || rawDoc.rollKey || '',
      centerCode: rawDoc.centerCode || rawDoc.centreCode || '',
      tests: {},
    };

    for (const [testName, testData] of Object.entries(rawDoc.tests || {})) {
      if (!testData || typeof testData !== 'object') continue;
      const one = { ...testData };
      if (one.total === undefined && one.Total !== undefined) one.total = one.Total;
      delete one.Total;
      normalized.tests[testName] = one;
    }

    return normalized;
  }
  // Legacy flat doc — convert on the fly
  return flatToNested(rawDoc);
}

// ── Load from Firestore (or local dev store when Firebase is off) ────────────

let memoryDevStore = null;

function getMemoryDevStore() {
  if (!memoryDevStore) {
    memoryDevStore = { profiles: [], tests: [], testColumns: [] };
  }
  return memoryDevStore;
}

/**
 * Full dataset for the API: Firestore when enabled, otherwise a single in-memory
 * object (local dev without Firebase credentials).
 */
export async function loadApplicationData() {
  if (!isFirestoreEnabled()) {
    return getMemoryDevStore();
  }
  return loadGlobalDataFromFirestore();
}

/**
 * Centre-filtered slice of global data (same shape as full global).
 */
export function sliceCenterFromGlobal(globalData, centerCode) {
  const profiles = globalData.profiles.filter((p) => p.centerCode === centerCode);
  const tests = globalData.tests.filter((t) => t.centerCode === centerCode);
  const colSet = new Set();
  tests.forEach((t) => {
    Object.keys(t).forEach((k) => {
      if (k !== 'ROLL_KEY' && k !== 'centerCode' && k !== 'stream') colSet.add(k);
    });
  });
  const testColumns = colSet.size > 0 ? Array.from(colSet) : globalData.testColumns;
  return { profiles, tests, testColumns };
}

async function fetchGlobalDataFromFirestoreOnce() {
  const db = getFirestore();
  const [pSnap, tSnap] = await Promise.all([
    db.collection(COL_PROFILES).get(),
    db.collection(COL_TESTS).get(),
  ]);

  const profiles = pSnap.docs.map((d) => d.data());

  const testColumnsSet = new Set();
  const tests = tSnap.docs.map((d) => {
    const raw = d.data();
    const nested = ensureNested(raw);
    const flat = nestedToFlat(nested);

    extractColumnsFromNestedTests(nested.tests).forEach((c) => testColumnsSet.add(c));

    return flat;
  });

  return {
    profiles,
    tests,
    testColumns: Array.from(testColumnsSet),
  };
}

function isQuotaError(err) {
  const code = err.code;
  const msg = err.message || String(err);
  return (
    code === 8 ||
    code === 'resource-exhausted' ||
    /RESOURCE_EXHAUSTED|quota exceeded|Quota exceeded/i.test(msg)
  );
}

/**
 * Load all profiles + test scores from Firestore.
 * Uses a short TTL cache to limit reads (see FIRESTORE_READ_CACHE_TTL_MS).
 * Tests are normalised from nested → flat so analytics code stays unchanged.
 */
export async function loadGlobalDataFromFirestore() {
  if (!isFirestoreEnabled()) {
    return { profiles: [], tests: [], testColumns: [] };
  }

  const ttl = readCacheTtlMs();
  const now = Date.now();
  if (ttl > 0 && firestoreReadCache.data && now < firestoreReadCache.expiresAt) {
    return firestoreReadCache.data;
  }

  try {
    const data = await fetchGlobalDataFromFirestoreOnce();
    if (ttl > 0) {
      firestoreReadCache = { data, expiresAt: now + ttl };
    }
    return data;
  } catch (err) {
    const code = err.code;
    const msg = err.message || String(err);
    console.error('[Firestore] loadGlobalDataFromFirestore failed:', code || '', msg);

    if (isQuotaError(err) && firestoreReadCache.data) {
      console.warn('[Firestore] Quota exceeded — serving last successful snapshot (may be stale).');
      return firestoreReadCache.data;
    }

    const e = new Error(
      code === 7 || /PERMISSION_DENIED|permission/i.test(msg)
        ? 'Firestore permission denied — check rules and that the service account can read collections.'
        : isQuotaError(err)
          ? 'Firestore quota exceeded (too many reads). Wait and retry, raise FIRESTORE_READ_CACHE_TTL_MS (e.g. 120000), or enable billing / upgrade limits in Firebase Console.'
          : `Firestore read failed (${code || 'error'}): ${msg}`
    );
    e.statusCode = 503;
    e.cause = err;
    throw e;
  }
}

// ── Individual CRUD operations ─────────────────────────────────────────────────

export async function upsertProfileDoc(student) {
  if (!isFirestoreEnabled()) return;
  const { centerCode, ROLL_KEY } = student;
  if (!centerCode || !ROLL_KEY) throw new Error('centerCode and ROLL_KEY are required');

  const db = getFirestore();
  const id = makeDocId(centerCode, ROLL_KEY);
  await db.collection(COL_PROFILES).doc(id).set(stripUndefined(student), { merge: true });
  invalidateFirestoreReadCache();
}

export async function deleteStudentDocs(centerCode, rollKey) {
  if (!isFirestoreEnabled()) return;
  const db  = getFirestore();
  const id  = makeDocId(centerCode, rollKey);
  const bat = db.batch();
  bat.delete(db.collection(COL_PROFILES).doc(id));
  bat.delete(db.collection(COL_TESTS).doc(id));
  await bat.commit();
  invalidateFirestoreReadCache();
}

/**
 * Upsert test scores for a student.
 *
 * @param {string} centerCode
 * @param {string} rollKey
 * @param {object} scores  Flat score map:  { "CAT-1(TEST)_Physics": 45, "CAT-1(TEST)": 145, ... }
 *                         OR nested patch:  { tests: { "CAT-1(TEST)": { Physics: 45, total: 145 } } }
 * @returns {object} Flat record as stored in Firestore
 */
export async function upsertTestDoc(centerCode, rollKey, scores) {
  if (!isFirestoreEnabled()) return {};

  const db  = getFirestore();
  const id  = makeDocId(centerCode, rollKey);
  const ref = db.collection(COL_TESTS).doc(id);

  const snap = await ref.get();
  const base = snap.exists ? ensureNested(snap.data()) : { ROLL_KEY: rollKey, centerCode, stream: 'JEE', tests: {} };

  // Accept either flat scores object or nested { tests: {...} } patch
  if (scores && typeof scores.tests === 'object') {
    // Nested patch — merge test-by-test
    for (const [testName, testData] of Object.entries(scores.tests)) {
      if (!base.tests[testName]) base.tests[testName] = {};
      Object.assign(base.tests[testName], testData);
    }
  } else {
    // Flat scores — convert and merge
    const patchNested = flatToNested({ ROLL_KEY: rollKey, centerCode, ...scores });
    for (const [testName, testData] of Object.entries(patchNested.tests)) {
      if (!base.tests[testName]) base.tests[testName] = {};
      Object.assign(base.tests[testName], testData);
    }
  }

  // Preserve stream if passed in scores
  if (scores.stream) base.stream = scores.stream;

  await ref.set(stripUndefined(base), { merge: false });

  invalidateFirestoreReadCache();
  return nestedToFlat(base);
}
