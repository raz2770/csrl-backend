import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';

let ready = false;

/**
 * Initialize Firebase Admin (Firestore). Returns true if credentials are loaded.
 * Use either FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON string) or
 * GOOGLE_APPLICATION_CREDENTIALS (path to a service account JSON file).
 */
export function initFirebaseApp() {
  if (ready) return true;
  if (admin.apps.length) {
    ready = true;
    return true;
  }
  try {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (json) {
      const cred = JSON.parse(json);
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
