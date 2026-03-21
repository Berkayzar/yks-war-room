// ============================================================================
// firebase.js
// Kurulum: npm install firebase
// ============================================================================
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};


const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ============================================================================
// Auth
// ============================================================================
const provider = new GoogleAuthProvider();
export const signInGoogle = () => signInWithPopup(auth, provider);
export const signOutUser  = () => signOut(auth);
export const onUser       = (cb) => onAuthStateChanged(auth, cb);

// ============================================================================
// Firestore helpers
// Path: users/{uid}/data/{storageKey}
// Keeps same key names as localStorage (yks_trials, yks_plan, etc.)
// ============================================================================

// Pull all 9 keys from Firestore at once, return as { key: value } map
export async function fsLoadAll(uid) {
  const STORAGE_KEYS = [
    "yks_trials", "yks_todos", "yks_brain", "yks_checkins",
    "yks_dw", "yks_xp", "yks_plan", "yks_attn", "yks_challenge",
  ];
  const results = await Promise.allSettled(
    STORAGE_KEYS.map((k) =>
      getDoc(doc(db, "users", uid, "data", k)).then((snap) => [k, snap.exists() ? snap.data().v : null])
    )
  );
  const out = {};
  results.forEach((r) => { if (r.status === "fulfilled" && r.value[1] !== null) out[r.value[0]] = r.value[1]; });
  return out;
}

// Write a single key to Firestore (fire-and-forget, never blocks UI)
export function fsSave(uid, key, value) {
  if (!uid) return;
  setDoc(doc(db, "users", uid, "data", key), { v: value }).catch(() => {});
}