import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

/**
 * Realtime Database, not Firestore — Firestore's free tier caps daily reads/
 * writes and bills past that; RTDB's Spark plan is free for an app this size
 * with no per-operation charge, just a storage/bandwidth ceiling.
 *
 * If the env vars are missing (no .env.local yet), `db` stays null and
 * reportsStore.js falls back to in-memory sample data so the app still runs.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(config.databaseURL && config.apiKey);

export const db = firebaseEnabled ? getDatabase(initializeApp(config)) : null;

if (!firebaseEnabled) {
  console.info(
    '[firebase] No VITE_FIREBASE_* env vars found — running on in-memory sample reports. ' +
      'Copy .env.example to .env.local and fill it in to use a real database.'
  );
}