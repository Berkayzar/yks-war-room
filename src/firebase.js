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
  getDocFromServer,
  setDoc,
  getDocs,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";

// ============================================================================
// Init -- single instance guarantee
// ============================================================================
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FB_API_KEY || "BURAYA_GERCEK_API_KEY",
  authDomain:        "yks-savas-odasi.firebaseapp.com",
  projectId:         "yks-savas-odasi",
  storageBucket:     "yks-savas-odasi.firebasestorage.app",
  messagingSenderId: "759165602271",
  appId:             "1:759165602271:web:65641344723986d8761c6a",
};

const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

export { app, auth, db };

// ============================================================================
// Auth
// ============================================================================
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

export const signOutUser   = () => signOut(auth);
export const onUser        = (cb) => onAuthStateChanged(auth, cb);
export const checkRedirect = () => getRedirectResult(auth).catch(() => null);

// ============================================================================
// Admin check (super admin -- admins collection)
// ============================================================================
export async function checkIsAdmin(uid) {
  try {
    const snap = await getDocFromServer(doc(db, "admins", uid));
    return snap.exists();
  } catch (e) {
    console.error("checkIsAdmin error:", e.code, e.message);
    return false;
  }
}

// ============================================================================
// User profile
// ============================================================================

/**
 * Profile shape (users/{uid}/profile/info):
 * {
 *   email, displayName, photoURL, lastSeen,
 *   role: "student" | "counselor" | "institution_admin" | "super_admin",
 *   institutionId: string | null,
 *   groupId: string | null,
 * }
 */

// Write profile on login -- preserves existing fields via merge
export function writeProfile(uid, user) {
  if (!uid) return;
  setDoc(doc(db, "users", uid, "profile", "info"), {
    email:       user.email       || "",
    displayName: user.displayName || "",
    photoURL:    user.photoURL    || "",
    lastSeen:    serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

// Read full profile
export async function getUserProfile(uid) {
  if (!uid) return null;
  try {
    const snap = await getDocFromServer(doc(db, "users", uid, "profile", "info"));
    console.log("getUserProfile uid:", uid, "exists:", snap.exists(), "data:", JSON.stringify(snap.data()));
    if (!snap.exists()) return null;
    return {
      role:          "student",
      institutionId: null,
      groupId:       null,
      ...snap.data(),
    };
  } catch (e) {
    console.error("getUserProfile error:", e.code, e.message);
    return null;
  }
}

// Set role -- call after onboarding role selection (Phase 1)
export async function setUserProfileRole(uid, role) {
  if (!uid || !role) return;
  try {
    await setDoc(doc(db, "users", uid, "profile", "info"), {
      role,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.error("setUserProfileRole error:", e.code, e.message);
  }
}

// Assign user to a group -- updates profile + group's studentUids[]
export async function assignUserToGroup(uid, institutionId, groupId) {
  if (!uid || !institutionId || !groupId) return;
  try {
    // 1. Update user profile
    await setDoc(doc(db, "users", uid, "profile", "info"), {
      institutionId,
      groupId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 2. Update userSummary so counselor panel sees it
    await setDoc(doc(db, "userSummaries", uid), {
      institutionId,
      groupId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 3. Add uid to group's studentUids array
    const groupRef  = doc(db, "institutions", institutionId, "groups", groupId);
    const groupSnap = await getDoc(groupRef);
    const existing  = groupSnap.exists() ? (groupSnap.data().studentUids || []) : [];
    if (!existing.includes(uid)) {
      await setDoc(groupRef, {
        studentUids: [...existing, uid],
        updatedAt:   serverTimestamp(),
      }, { merge: true });
    }
  } catch (e) {
    console.error("assignUserToGroup error:", e.code, e.message);
  }
}

// ============================================================================
// Institution helpers (Phase 0 foundation -- no UI yet)
// ============================================================================

/**
 * Institution shape (institutions/{id}):
 * {
 *   name, plan, ownerUid, createdAt
 * }
 */
export async function createInstitution(ownerUid, name) {
  if (!ownerUid || !name) return null;
  try {
    const id  = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ref = doc(db, "institutions", id);
    await setDoc(ref, {
      name,
      plan:      "trial",
      ownerUid,
      createdAt: serverTimestamp(),
    });
    // Set owner's profile as institution_admin
    await setUserProfileRole(ownerUid, "institution_admin");
    await setDoc(doc(db, "users", ownerUid, "profile", "info"), {
      institutionId: id,
    }, { merge: true });
    return id;
  } catch (e) {
    console.error("createInstitution error:", e.code, e.message);
    return null;
  }
}

/**
 * Group shape (institutions/{id}/groups/{id}):
 * {
 *   name, counselorUid, studentUids[], createdAt
 * }
 */
export async function createGroup(institutionId, counselorUid, name) {
  if (!institutionId || !name) return null;
  try {
    const id  = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ref = doc(db, "institutions", institutionId, "groups", id);
    await setDoc(ref, {
      name,
      counselorUid: counselorUid || null,
      studentUids:  [],
      createdAt:    serverTimestamp(),
    });
    // If counselor uid given, update their profile
    if (counselorUid) {
      await setDoc(doc(db, "users", counselorUid, "profile", "info"), {
        institutionId,
        groupId:   id,
        role:      "counselor",
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
    return id;
  } catch (e) {
    console.error("createGroup error:", e.code, e.message);
    return null;
  }
}

// ============================================================================
// Student data (unchanged)
// ============================================================================
const DATA_KEYS = [
  "yks_trials", "yks_todos", "yks_brain", "yks_checkins",
  "yks_dw", "yks_xp", "yks_plan", "yks_attn", "yks_challenge",
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
  // Strip undefined values -- Firestore rejects them
  const clean = JSON.parse(JSON.stringify(value ?? null));
  setDoc(doc(db, "users", uid, "data", key), { v: clean }).catch(() => {});
}

// ============================================================================
// Summary (unchanged + new fields supported via merge)
// ============================================================================
let _summaryTimer   = null;
let _pendingSummary = null;

export function scheduleSummary(uid, data) {
  if (!uid) return;
  _pendingSummary = data;
  if (_summaryTimer) return;
  _summaryTimer = setTimeout(() => {
    if (_pendingSummary) {
      setDoc(doc(db, "userSummaries", uid), {
        ..._pendingSummary,
        lastSeen: serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
    _pendingSummary = null;
    _summaryTimer   = null;
  }, 3000);
}

// ============================================================================
// Activity log (unchanged)
// ============================================================================
const _cooldown = {};

export function logActivity(uid, key) {
  if (!uid) return;
  const now = Date.now();
  if (_cooldown[key] && now - _cooldown[key] < 60000) return;
  _cooldown[key] = now;
  addDoc(collection(db, "users", uid, "activity"), {
    key,
    at: serverTimestamp(),
  }).catch(() => {});
}

// ============================================================================
// Admin panel helpers (unchanged)
// ============================================================================
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
        getDoc(doc(db, "users", uid, "data", k))
          .then((s) => [k, s.exists() ? s.data().v : null])
      )),
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

// ============================================================================
// Phase 1 -- Counselor dashboard helpers
// ============================================================================

// Get all userSummaries for a given institution (+ optional group filter)
// Uses existing userSummaries collection -- no new collection needed
export async function getGroupStudents(institutionId, groupId) {
  if (!institutionId) return [];
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    return snap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) =>
        u.institutionId === institutionId &&
        u.role !== "counselor" &&
        u.role !== "institution_admin" &&
        u.role !== "super_admin" &&
        (groupId ? u.groupId === groupId : true)
      );
  } catch (e) {
    console.error("getGroupStudents error:", e.code, e.message);
    return [];
  }
}

// ============================================================================
// Phase 2 -- super_admin assignment panel helpers
// ============================================================================

// Get all users from userSummaries (includes role, institutionId, groupId)
export async function getAllUsers() {
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  } catch (e) {
    console.error("getAllUsers error:", e.code, e.message);
    return [];
  }
}

// Update role in both profile/info and userSummaries
export async function updateUserProfileRole(uid, role) {
  if (!uid || !role) return false;
  try {
    await Promise.all([
      setDoc(doc(db, "users", uid, "profile", "info"), {
        role,
        updatedAt: serverTimestamp(),
      }, { merge: true }),
      setDoc(doc(db, "userSummaries", uid), {
        role,
        updatedAt: serverTimestamp(),
      }, { merge: true }),
    ]);
    return true;
  } catch (e) {
    console.error("updateUserProfileRole error:", e.code, e.message);
    return false;
  }
}

// Update institutionId and groupId in both profile/info and userSummaries
export async function updateUserInstitutionGroup(uid, institutionId, groupId) {
  if (!uid) return false;
  try {
    const data = {
      institutionId: institutionId || null,
      groupId:       groupId       || null,
      updatedAt:     serverTimestamp(),
    };
    await Promise.all([
      setDoc(doc(db, "users", uid, "profile", "info"), data, { merge: true }),
      setDoc(doc(db, "userSummaries", uid),             data, { merge: true }),
    ]);
    return true;
  } catch (e) {
    console.error("updateUserInstitutionGroup error:", e.code, e.message);
    return false;
  }
}

// ============================================================================
// Phase 3 -- Counselor notes
// counselorNotes/{studentUid}/notes/{noteId}
// ============================================================================
export async function addCounselorNote(counselorUid, studentUid, text) {
  if (!counselorUid || !studentUid || !text?.trim()) return null;
  try {
    const ref = await addDoc(
      collection(db, "counselorNotes", studentUid, "notes"),
      {
        counselorUid,
        text:      text.trim(),
        createdAt: serverTimestamp(),
      }
    );
    return ref.id;
  } catch (e) {
    console.error("addCounselorNote error:", e.code, e.message);
    return null;
  }
}

export async function getCounselorNotes(studentUid) {
  if (!studentUid) return [];
  try {
    const snap = await getDocs(
      query(
        collection(db, "counselorNotes", studentUid, "notes"),
        orderBy("createdAt", "desc"),
        limit(20)
      )
    );
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("getCounselorNotes error:", e.code, e.message);
    return [];
  }
}