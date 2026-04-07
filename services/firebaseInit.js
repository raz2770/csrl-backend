import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';

let ready = false;
const HARDCODED_SERVICE_ACCOUNT_PATH = new URL('../config/serviceAccountKey.json', import.meta.url);

/**
 * Initialize Firebase Admin (Firestore). Returns true if credentials are loaded.
 * Primary source: hardcoded service account key file in backend config.
 * Fallbacks: FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64,
 * GOOGLE_APPLICATION_CREDENTIALS.
 */
export function initFirebaseApp() {
  if (ready) return true;
  if (admin.apps.length) {
    ready = true;
    return true;
  }
  try {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const b64  = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (existsSync(HARDCODED_SERVICE_ACCOUNT_PATH)) {
      const cred = JSON.parse(readFileSync(HARDCODED_SERVICE_ACCOUNT_PATH, 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    } else if (json) {
      const cred = JSON.parse(json);
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    } else if (b64) {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const cred = JSON.parse(decoded);
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    } else if (path && existsSync(path)) {
      const cred = JSON.parse(readFileSync(path, 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    } else {
      return false;
    }
    ready = true;
    console.log('[Firebase] Admin SDK initialized');
    return true;
  } catch (e) {
    console.error('[Firebase] Init failed:', e.message);
    return false;
  }
}

export function isFirebaseReady() {
  return ready && admin.apps.length > 0;
}
