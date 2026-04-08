import NodeCache from 'node-cache';
import { getFirestore } from 'firebase-admin/firestore';
import { initFirebaseApp } from './firebaseInit.js';
import { flatToNested, nestedToFlat, extractColumnsFromNestedTests } from '../utils/testColumns.js';

const COL_PROFILES = 'students';
const COL_TESTS = 'testScores';

const GLOBAL_DATA_CACHE_KEY = 'globalData';

function readCacheTtlMs() {
  const raw = process.env.FIRESTORE_READ_CACHE_TTL_MS;
  if (raw === '0' || raw === '') return 0;
  const n = parseInt(raw ?? '90000', 10);
  return Number.isFinite(n) && n >= 0 ? n : 90000;
}

/** NodeCache uses seconds; env is milliseconds. */
function readCacheTtlSeconds() {
  const ms = readCacheTtlMs();
  return ms <= 0 ? 0 : Math.max(1, Math.floor(ms / 1000));
}

const ttlSec = readCacheTtlSeconds() || 90;
const globalDataCache = new NodeCache({
  stdTTL: ttlSec,
  checkperiod: Math.min(120, Math.max(20, Math.floor(ttlSec / 2))),
  useClones: true,
});

export function invalidateFirestoreReadCache() {
  globalDataCache.del(GLOBAL_DATA_CACHE_KEY);
}

/** For /api/health — confirms node-cache settings (TTL from FIRESTORE_READ_CACHE_TTL_MS). */
export function getReadCacheStatus() {
  const ttlMs = readCacheTtlMs();
  return {
    backend: 'node-cache',
    ttlMs,
    ttlSeconds: ttlMs > 0 ? readCacheTtlSeconds() : 0,
    enabled: ttlMs > 0,
    key: GLOBAL_DATA_CACHE_KEY,
  };
}

export function isFirestoreEnabled() {
  return initFirebaseApp();
}

export function makeDocId(centerCode, rollKey) {
  void centerCode;
  const r = String(rollKey ?? '').trim().replace(/\//g, '_');
  return r;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function isNestedFormat(doc) {
  return doc && typeof doc.tests === 'object' && doc.tests !== null;
}

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
  return flatToNested(rawDoc);
}

let memoryDevStore = null;

function getMemoryDevStore() {
  if (!memoryDevStore) {
    memoryDevStore = { profiles: [], tests: [], testColumns: [] };
  }
  return memoryDevStore;
}

/**
 * Full dataset: Firestore (with node-cache TTL) when configured, else in-memory dev store.
 */
export async function loadApplicationData() {
  if (!isFirestoreEnabled()) {
    return getMemoryDevStore();
  }
  return loadGlobalDataFromFirestore();
}

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

function buildReadError(err) {
  const code = err.code;
  const msg = err.message || String(err);
  const denied = code === 7 || /PERMISSION_DENIED|permission/i.test(msg);
  const quota =
    code === 8 ||
    code === 'resource-exhausted' ||
    /RESOURCE_EXHAUSTED|quota exceeded|Quota exceeded/i.test(msg);

  const text = denied
    ? 'Firestore permission denied — check rules and service account.'
    : quota
      ? 'Firestore quota exceeded — increase FIRESTORE_READ_CACHE_TTL_MS or upgrade plan.'
      : `Firestore read failed (${code ?? 'error'}): ${msg}`;

  const e = new Error(text);
  e.statusCode = 503;
  e.cause = err;
  return e;
}

/**
 * Loads all profiles + tests from Firestore with node-cache (TTL from FIRESTORE_READ_CACHE_TTL_MS).
 * Invalidated after writes via invalidateFirestoreReadCache().
 * Throws on failure (no live Firestore read and no valid cache entry).
 */
export async function loadGlobalDataFromFirestore() {
  if (!isFirestoreEnabled()) {
    return { profiles: [], tests: [], testColumns: [] };
  }

  const ttlMs = readCacheTtlMs();

  if (ttlMs > 0) {
    const cached = globalDataCache.get(GLOBAL_DATA_CACHE_KEY);
    if (cached) {
      return {
        profiles: cached.profiles ?? [],
        tests: cached.tests ?? [],
        testColumns: cached.testColumns ?? [],
      };
    }
  }

  try {
    const data = await fetchGlobalDataFromFirestoreOnce();
    const out = {
      profiles: data.profiles,
      tests: data.tests,
      testColumns: data.testColumns,
    };
    if (ttlMs > 0) {
      globalDataCache.set(GLOBAL_DATA_CACHE_KEY, {
        profiles: out.profiles,
        tests: out.tests,
        testColumns: out.testColumns,
      });
    }
    return out;
  } catch (err) {
    console.error('[Firestore] loadGlobalDataFromFirestore failed:', err.code || '', err.message || err);
    throw buildReadError(err);
  }
}

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
  const db = getFirestore();
  const id = makeDocId(centerCode, rollKey);
  const bat = db.batch();
  bat.delete(db.collection(COL_PROFILES).doc(id));
  bat.delete(db.collection(COL_TESTS).doc(id));
  await bat.commit();
  invalidateFirestoreReadCache();
}

export async function upsertTestDoc(centerCode, rollKey, scores) {
  if (!isFirestoreEnabled()) return {};

  const db = getFirestore();
  const id = makeDocId(centerCode, rollKey);
  const ref = db.collection(COL_TESTS).doc(id);

  const snap = await ref.get();
  const base = snap.exists ? ensureNested(snap.data()) : { ROLL_KEY: rollKey, centerCode, stream: 'JEE', tests: {} };

  if (scores && typeof scores.tests === 'object') {
    for (const [testName, testData] of Object.entries(scores.tests)) {
      if (!base.tests[testName]) base.tests[testName] = {};
      Object.assign(base.tests[testName], testData);
    }
  } else {
    const patchNested = flatToNested({ ROLL_KEY: rollKey, centerCode, ...scores });
    for (const [testName, testData] of Object.entries(patchNested.tests)) {
      if (!base.tests[testName]) base.tests[testName] = {};
      Object.assign(base.tests[testName], testData);
    }
  }

  if (scores.stream) base.stream = scores.stream;

  await ref.set(stripUndefined(base), { merge: false });
  invalidateFirestoreReadCache();
  return nestedToFlat(base);
}
