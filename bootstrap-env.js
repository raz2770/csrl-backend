/**
 * Load env and set Firestore transport before any firebase-admin / @google-cloud/firestore code runs.
 * On Render and similar hosts, gRPC to Firestore can fail while REST works reliably.
 */
import 'dotenv/config';

if (!process.env.FIRESTORE_PREFER_REST) {
  process.env.FIRESTORE_PREFER_REST = 'true';
}
