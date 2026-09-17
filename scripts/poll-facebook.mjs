import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push } from 'firebase/database';

const config = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.VITE_FIREBASE_DATABASE_URL,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

const firebaseEnabled = Boolean(
  config.apiKey && config.databaseURL
);

const db = firebaseEnabled
  ? getDatabase(initializeApp(config))
  : null;

console.log(
  `[firebase] ${firebaseEnabled ? 'Firebase enabled' : 'Firebase disabled'}`
);
