import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
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
  apiKey:            import.meta.env.VITE_FB_API_KEY || "BURAYA_GERCEK_API_KEY",
  authDomain:        "yks-savas-odasi.firebaseapp.com",
  projectId:         "yks-savas-odasi",
  storageBucket:     "yks-savas-odasi.firebasestorage.app",
  messagingSenderId: "759165602271",
  appId:             "1:759165602271:web:65641344723986d8761c6a",
};

// Tek instance garantisi
const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

console.log("Firebase app name:", app.name, "projectId:", app.options.projectId);

export { app, auth, db };

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export const signInGoogle = async () => {
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/popup-closed-by-user") {
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
};

export const signOutUser  = () => signOut(auth);
export const onUser       = (cb) => onAuthStateChanged(auth, cb);
export const checkRedirect = () => getRedirectResult(auth).catch(() => null);

export async function checkIsAdmin(uid) {
  console.log("checkIsAdmin called with uid:", uid, "db projectId:", db.app.options.projectId);
  try {
    const snap = await getDoc(doc(db, "admins", uid));
    console.log("checkIsAdmin exists:", snap.exists(), "ref:", snap.ref.path);
    return snap.exists();
  } catch (e) {
    console.error("checkIsAdmin error:", e.code, e.message);
    return false;
  }
}

const DATA_KEYS = [
  "yks_trials","yks_todos","yks_brain","yks_checkins",
  "yks_dw","yks_xp","yks_plan","yks_attn","yks_challenge",
];

export async function fsLoadAll(uid) {
  if (!uid) return {};
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
  if (!uid) return;
  setDoc(doc(db, "users", uid, "data", key), { v: value }).catch(() => {});
}

export function writeProfile(uid, user) {
  if (!uid) return;
  setDoc(doc(db, "users", uid, "profile", "info"), {
    email: user.email || "", displayName: user.displayName || "",
    photoURL: user.photoURL || "", lastSeen: serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

let _summaryTimer = null;
let _pendingSummary = null;

export function scheduleSummary(uid, data) {
  if (!uid) return;
  _pendingSummary = data;
  if (_summaryTimer) return;
  _summaryTimer = setTimeout(() => {
    if (_pendingSummary) {
      setDoc(doc(db, "userSummaries", uid), { ..._pendingSummary, lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
    }
    _pendingSummary = null;
    _summaryTimer  = null;
  }, 3000);
}

const _cooldown = {};
export function logActivity(uid, key) {
  if (!uid) return;
  const now = Date.now();
  if (_cooldown[key] && now - _cooldown[key] < 60000) return;
  _cooldown[key] = now;
  addDoc(collection(db, "users", uid, "activity"), { key, at: serverTimestamp() }).catch(() => {});
}

export async function adminGetUsers() {
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  } catch { return []; }
}

export async function adminGetUserData(uid) {
  if (!uid) return null;
  try {
    const [dataResults, profileSnap, activitySnap] = await Promise.all([
      Promise.allSettled(DATA_KEYS.map((k) =>
        getDoc(doc(db, "users", uid, "data", k)).then((s) => [k, s.exists() ? s.data().v : null])
      )),
      getDoc(doc(db, "users", uid, "profile", "info")),
      getDocs(query(collection(db, "users", uid, "activity"), orderBy("at", "desc"), limit(20))),
    ]);
    const data = {};
    dataResults.forEach((r) => {
      if (r.status === "fulfilled" && r.value[1] !== null) data[r.value[0]] = r.value[1];
    });
    return {
      data,
      profile:  profileSnap.exists() ? profileSnap.data() : {},
      activity: activitySnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
  } catch (e) {
    console.error("adminGetUserData error:", e);
    return null;
  }
}