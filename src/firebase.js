import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FB_API_KEY || "BURAYA_GERCEK_API_KEY_YAZ",
  authDomain:        "yks-savas-odasi.firebaseapp.com",
  projectId:         "yks-savas-odasi",
  storageBucket:     "yks-savas-odasi.firebasestorage.app",
  messagingSenderId: "759165602271",
  appId:             "1:759165602271:web:65641344723986d8761c6a",
};

let app  = null;
let auth = null;
let db   = null;

try {
  app  = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getFirestore(app);
} catch (e) {
  console.error("Firebase init failed:", e);
}

export { app, auth, db };

// ============================================================================
// Auth
// ============================================================================
const provider = new GoogleAuthProvider()
export const signInGoogle = () => {
  if (!auth) return Promise.reject(new Error("auth not ready"));
  console.log("signInGoogle called, hostname:", window.location.hostname);
  return signInWithRedirect(auth, provider).catch((e) => {
    console.error("redirect error:", e.code, e.message);
    throw e;
  });
};

export const signOutUser = () => {
  if (!auth) return Promise.resolve();
  return signOut(auth);
};

export const onUser = (cb) => {
  if (!auth) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
};

export const checkRedirect = () => {
  if (!auth) return Promise.resolve(null);
  return getRedirectResult(auth).catch(() => null);
};

// ============================================================================
// Admin check
// ============================================================================
export async function checkIsAdmin(uid) {
  if (!db || !uid) return false;
  try {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch {
    return false;
  }
}

// ============================================================================
// User data (mevcut, degismedi)
// ============================================================================
const DATA_KEYS = [
  "yks_trials", "yks_todos", "yks_brain", "yks_checkins",
  "yks_dw", "yks_xp", "yks_plan", "yks_attn", "yks_challenge",
];

export async function fsLoadAll(uid) {
  if (!db || !uid) return {};
  const results = await Promise.allSettled(
    DATA_KEYS.map((k) =>
      getDoc(doc(db, "users", uid, "data", k))
        .then((snap) => [k, snap.exists() ? snap.data().v : null])
    )
  );
  const out = {};
  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value[1] !== null) out[r.value[0]] = r.value[1];
  });
  return out;
}

export function fsSave(uid, key, value) {
  if (!db || !uid) return;
  setDoc(doc(db, "users", uid, "data", key), { v: value }).catch(() => {});
}

// ============================================================================
// Profile + activity yazma (login sonrasi cagirilir)
// ============================================================================
export function writeProfile(uid, user) {
  if (!db || !uid) return;
  setDoc(doc(db, "users", uid, "profile", "info"), {
    email:       user.email || "",
    displayName: user.displayName || "",
    photoURL:    user.photoURL || "",
    lastSeen:    serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

// ============================================================================
// Summary yazma (her store.save'de cagirilir, throttled)
// Ozet: xp, streak, plan/todo/trial count, lastKey, lastSeen
// ============================================================================
let _summaryTimer = null;
let _pendingSummary = null;

export function scheduleSummary(uid, summaryData) {
  if (!db || !uid) return;
  _pendingSummary = summaryData;
  if (_summaryTimer) return; // zaten bekliyor
  _summaryTimer = setTimeout(() => {
    if (_pendingSummary) {
      setDoc(doc(db, "userSummaries", uid), {
        ..._pendingSummary,
        lastSeen: serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
    _pendingSummary = null;
    _summaryTimer = null;
  }, 3000); // 3 sn throttle
}

// ============================================================================
// Activity log yazma (key bazi, son 1 dakikada tekrar etmez)
// ============================================================================
const _activityCooldown = {};

export function logActivity(uid, key) {
  if (!db || !uid) return;
  const now = Date.now();
  if (_activityCooldown[key] && now - _activityCooldown[key] < 60000) return;
  _activityCooldown[key] = now;
  addDoc(collection(db, "users", uid, "activity"), {
    key,
    at: serverTimestamp(),
  }).catch(() => {});
}

// ============================================================================
// Admin: tum kullanicilarin ozet listesi
// ============================================================================
export async function adminGetUsers() {
  if (!db) return [];
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

// ============================================================================
// Admin: belirli kullanicinin tum datasini oku
// ============================================================================
export async function adminGetUserData(uid) {
  if (!db || !uid) return null;
  try {
    const [dataResults, profileSnap, activitySnap] = await Promise.all([
      Promise.allSettled(
        DATA_KEYS.map((k) =>
          getDoc(doc(db, "users", uid, "data", k))
            .then((snap) => [k, snap.exists() ? snap.data().v : null])
        )
      ),
      getDoc(doc(db, "users", uid, "profile", "info")),
      getDocs(query(
        collection(db, "users", uid, "activity"),
        orderBy("at", "desc"),
        limit(20)
      )),
    ]);

    const data = {};
    dataResults.forEach((r) => {
      if (r.status === "fulfilled" && r.value[1] !== null) data[r.value[0]] = r.value[1];
    });

    const profile = profileSnap.exists() ? profileSnap.data() : {};
    const activity = activitySnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return { data, profile, activity };
  } catch (e) {
    console.error("adminGetUserData error:", e);
    return null;
  }
}