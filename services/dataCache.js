/**
 * In-memory data cache backed exclusively by Firestore.
 * Replaces the old googleSheets.js poller — no CSV / HTTP fetching.
 *
 * Lifecycle:
 *   1. initializeCache()   — called once on server start
 *   2. hydrateCache()      — called after any CRUD mutation to keep cache fresh
 *   3. getGlobalData()     — returns full { profiles, tests, testColumns }
 *   4. getCenterData(code) — returns centre-filtered slice
 */

import NodeCache from 'node-cache';
import { CENTERS_CONFIG } from '../config/centers.js';
import {
  isFirestoreEnabled,
  loadGlobalDataFromFirestore,
} from './firestoreService.js';

// Cache TTL 30 min — mainly guards against cold-start memory loss; manual
// hydration after every CRUD keeps it fresh in practice.
const dataCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

// ── Per-centre slice builder ──────────────────────────────────────────────────

function buildIndividualCenters(globalData) {
  const result = {};

  for (const code of Object.keys(CENTERS_CONFIG)) {
    const profiles = globalData.profiles.filter((p) => p.centerCode === code);
    const tests    = globalData.tests.filter((t)    => t.centerCode === code);

    // Derive test columns that actually appear in this centre's test records
    const colSet = new Set();
    tests.forEach((t) => {
      Object.keys(t).forEach((k) => {
        if (k !== 'ROLL_KEY' && k !== 'centerCode' && k !== 'stream') colSet.add(k);
      });
    });

    // Fall back to the global list when this centre has no test records yet
    const testColumns = colSet.size > 0 ? Array.from(colSet) : globalData.testColumns;

    result[code] = { profiles, tests, testColumns };
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reload the in-memory cache from Firestore.
 * Call this on startup and after every write (add/update/delete student or scores).
 */
export async function hydrateCache() {
  if (!isFirestoreEnabled()) {
    console.warn('[Cache] Firestore not enabled — cache stays empty');
    return false;
  }

  const globalData = await loadGlobalDataFromFirestore();
  dataCache.set('GLOBAL_DATA',        globalData);
  dataCache.set('INDIVIDUAL_CENTERS', buildIndividualCenters(globalData));

  const count = globalData.profiles.length;
  console.log(`[Cache] Hydrated from Firestore — ${count} profiles, ${globalData.tests.length} test records`);
  return count > 0 || globalData.tests.length > 0;
}

/**
 * Boot-time initialisation. Loads Firestore data into the cache.
 * Logs a warning (not an error) when Firestore is empty — that is expected
 * for a fresh deployment.
 */
export async function initializeCache() {
  console.log('[Cache] Initialising from Firestore…');
  const hasData = await hydrateCache();
  if (!hasData) {
    console.warn('[Cache] Firestore appears empty. Add students via the Admin UI.');
  }
}

export function getGlobalData() {
  return dataCache.get('GLOBAL_DATA') || { profiles: [], tests: [], testColumns: [] };
}

export function getCenterData(centerCode) {
  const centers = dataCache.get('INDIVIDUAL_CENTERS') || {};
  return centers[centerCode] || { profiles: [], tests: [], testColumns: [] };
}
