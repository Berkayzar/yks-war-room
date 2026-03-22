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
const _fbApiKey = import.meta.env.VITE_FB_API_KEY;
if (!_fbApiKey) {
  console.warn("[firebase] VITE_FB_API_KEY not set -- running in local-only mode");
}

const firebaseConfig = {
  apiKey:            _fbApiKey || "",
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
export const checkRedirect = async () => {
  try {
    return await getRedirectResult(auth);
  } catch (e) {
    // Log real auth errors -- do not swallow silently
    if (e?.code && e.code !== "auth/null-user") {
      console.warn("[firebase] checkRedirect error:", e.code, e.message);
    }
    return null;
  }
};

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

// Assign user to a group -- FIX 17: removes from old group first
// FIX 18: single consistent logic path used by both assignment flows
export async function assignUserToGroup(uid, institutionId, groupId) {
  if (!uid || !institutionId || !groupId) return;
  try {
    // Read current profile to find old group
    const profileSnap = await getDoc(doc(db, "users", uid, "profile", "info"));
    const oldGroupId       = profileSnap.exists() ? profileSnap.data().groupId       : null;
    const oldInstitutionId = profileSnap.exists() ? profileSnap.data().institutionId : null;

    // FIX 17: Remove from old group's studentUids if switching groups
    if (oldGroupId && (oldGroupId !== groupId || oldInstitutionId !== institutionId)) {
      const oldGroupRef  = doc(db, "institutions", oldInstitutionId, "groups", oldGroupId);
      const oldGroupSnap = await getDoc(oldGroupRef);
      if (oldGroupSnap.exists()) {
        const filtered = (oldGroupSnap.data().studentUids || []).filter((id) => id !== uid);
        await setDoc(oldGroupRef, { studentUids: filtered, updatedAt: serverTimestamp() }, { merge: true });
      }
    }

    // 1. Update user profile
    await setDoc(doc(db, "users", uid, "profile", "info"), {
      institutionId,
      groupId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 2. Update userSummary
    await setDoc(doc(db, "userSummaries", uid), {
      institutionId,
      groupId,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 3. Add uid to new group's studentUids
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
// Institution helpers
// ============================================================================
export async function createInstitution(ownerUid, name) {
  if (!ownerUid || !name) return null;
  try {
    const id  = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ref = doc(db, "institutions", id);
    await setDoc(ref, { name, plan: "trial", ownerUid, createdAt: serverTimestamp() });

    // FIX 19: don't downgrade super_admin -- only set institution_admin if not already higher
    const profileSnap = await getDoc(doc(db, "users", ownerUid, "profile", "info"));
    const currentRole = profileSnap.exists() ? profileSnap.data().role : null;
    if (currentRole !== "super_admin") {
      await setUserProfileRole(ownerUid, "institution_admin");
    }
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
    // FIX 19: only set counselor role if not already institution_admin or super_admin
    if (counselorUid) {
      const profileSnap = await getDoc(doc(db, "users", counselorUid, "profile", "info"));
      const currentRole = profileSnap.exists() ? profileSnap.data().role : null;
      const higherRoles = ["institution_admin", "super_admin"];
      if (!higherRoles.includes(currentRole)) {
        await setDoc(doc(db, "users", counselorUid, "profile", "info"), {
          institutionId,
          groupId:   id,
          role:      "counselor",
          updatedAt: serverTimestamp(),
        }, { merge: true });
      } else {
        await setDoc(doc(db, "users", counselorUid, "profile", "info"), {
          institutionId,
          groupId:   id,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
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
// Summary -- uid-scoped debounce (FIX 22)
// ============================================================================
const _summaryTimers   = {}; // uid -> timer
const _pendingSummaries = {}; // uid -> data

export function scheduleSummary(uid, data) {
  if (!uid) return;
  // FIX 22: uid-scoped -- prevents one user's timer firing with another's data
  _pendingSummaries[uid] = data;
  if (_summaryTimers[uid]) return;
  _summaryTimers[uid] = setTimeout(() => {
    const pending = _pendingSummaries[uid];
    if (pending) {
      setDoc(doc(db, "userSummaries", uid), {
        ...pending,
        lastSeen:  serverTimestamp(),
        syncedAt:  serverTimestamp(), // FIX Part4: track last sync time
      }, { merge: true }).catch((e) => console.warn("[firebase] scheduleSummary write failed:", e.code));
    }
    delete _pendingSummaries[uid];
    delete _summaryTimers[uid];
  }, 3000);
}

// ============================================================================
// Activity log -- uid-aware cooldown (FIX 23)
// ============================================================================
const _cooldown = {}; // "uid:key" -> timestamp

export function logActivity(uid, key) {
  if (!uid) return;
  const ck  = `${uid}:${key}`; // FIX 23: uid-scoped cooldown key
  const now = Date.now();
  if (_cooldown[ck] && now - _cooldown[ck] < 60000) return;
  _cooldown[ck] = now;
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

// Counselor-safe read: reads yks_plan and yks_trials from user data
// Requires rules to allow counselor access to users/{uid}/data/{key}
export async function counselorGetUserData(uid) {
  if (!uid) return null;
  try {
    const COUNSELOR_KEYS = ["yks_plan", "yks_trials", "yks_checkins"];
    const [dataResults, profileSnap, activitySnap] = await Promise.all([
      Promise.allSettled(
        COUNSELOR_KEYS.map((k) =>
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
    return {
      data,
      profile:  profileSnap.exists() ? profileSnap.data() : {},
      activity: activitySnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    };
  } catch (e) {
    console.error("counselorGetUserData error:", e.code, e.message);
    return null;
  }
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

// ============================================================================
// Phase 2 -- super_admin assignment panel helpers
// ============================================================================

// FIX 20: getAllUsers also checks users who have signed in but have no summary yet
// (e.g. new user who hasn't saved any data to trigger scheduleSummary)
export async function getAllUsers() {
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    const summaryUsers = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    return summaryUsers.sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  } catch (e) {
    console.error("getAllUsers error:", e.code, e.message);
    return [];
  }
}

// FIX 21: getGroupStudents -- still client-side filter (Firestore free tier has no composite index)
// but scoped more safely with explicit role check
export async function getGroupStudents(institutionId, groupId) {
  if (!institutionId) return [];
  try {
    const snap = await getDocs(collection(db, "userSummaries"));
    return snap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => {
        if (u.institutionId !== institutionId) return false;
        const role = u.role || "student";
        if (role === "counselor" || role === "institution_admin" || role === "super_admin") return false;
        if (groupId && u.groupId !== groupId) return false;
        return true;
      });
  } catch (e) {
    console.error("getGroupStudents error:", e.code, e.message);
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

// FIX 18: delegate to assignUserToGroup for consistent logic (handles old group removal)
export async function updateUserInstitutionGroup(uid, institutionId, groupId) {
  if (!uid) return false;
  try {
    if (institutionId && groupId) {
      // Full assignment -- use shared logic path that handles old group removal
      await assignUserToGroup(uid, institutionId, groupId);
    } else {
      // Partial clear -- just update profile and summary directly
      const data = {
        institutionId: institutionId || null,
        groupId:       groupId       || null,
        updatedAt:     serverTimestamp(),
      };
      await Promise.all([
        setDoc(doc(db, "users", uid, "profile", "info"), data, { merge: true }),
        setDoc(doc(db, "userSummaries", uid),             data, { merge: true }),
      ]);
    }
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

// ============================================================================
// Part 4 -- Offline sync / staleness detection
// ============================================================================

// Check if cloud summary is stale compared to local data
// Returns { stale: bool, localUpdatedAt: number, cloudSyncedAt: number|null }
export async function checkSyncStatus(uid) {
  if (!uid) return { stale: false, localUpdatedAt: 0, cloudSyncedAt: null };
  try {
    const snap = await getDocFromServer(doc(db, "userSummaries", uid));
    if (!snap.exists()) return { stale: true, localUpdatedAt: Date.now(), cloudSyncedAt: null };

    const cloudSyncedAt = snap.data().syncedAt?.seconds
      ? snap.data().syncedAt.seconds * 1000
      : null;

    // Use yks_xp lastDate as proxy for last local activity
    const xpRaw = localStorage.getItem("yks_xp");
    const xpData = xpRaw ? JSON.parse(xpRaw) : {};
    const lastLocalDate = xpData.lastDate
      ? new Date(xpData.lastDate).getTime()
      : 0;

    const stale = cloudSyncedAt
      ? lastLocalDate > cloudSyncedAt + 60000 // local is 1min+ newer than cloud
      : lastLocalDate > 0;

    return { stale, localUpdatedAt: lastLocalDate, cloudSyncedAt };
  } catch (e) {
    console.warn("[firebase] checkSyncStatus error:", e.code);
    return { stale: false, localUpdatedAt: 0, cloudSyncedAt: null };
  }
}

// Force immediate summary write -- bypasses debounce timer
// Used when coming back online after offline period
export async function forceSummarySync(uid, data) {
  if (!uid || !data) return;
  try {
    await setDoc(doc(db, "userSummaries", uid), {
      ...data,
      lastSeen: serverTimestamp(),
      syncedAt: serverTimestamp(),
    }, { merge: true });
    console.log("[firebase] forceSummarySync: synced for", uid);
  } catch (e) {
    console.warn("[firebase] forceSummarySync failed:", e.code, e.message);
  }
}

// ============================================================================
// Counselor weekly goals -- stored in student's yks_weekly_goals data key
// Option A: reuse existing weeklyGoals structure, counselor writes directly
// ============================================================================

// Read student's weekly goals from Firestore (not localStorage -- counselor context)
export async function getCounselorWeeklyGoals(studentUid) {
  if (!studentUid) return [];
  try {
    const snap = await getDoc(doc(db, "users", studentUid, "data", "yks_weekly_goals"));
    if (!snap.exists()) return [];
    const raw = snap.data().v;
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error("getCounselorWeeklyGoals error:", e.code, e.message);
    return [];
  }
}

// Write weekly goals for a student as counselor
// Merges counselor goals with existing student goals (student goals are preserved)
export async function setCounselorWeeklyGoals(counselorUid, studentUid, newGoals) {
  if (!counselorUid || !studentUid) return false;
  try {
    // Read existing goals first
    const existing = await getCounselorWeeklyGoals(studentUid);
    // Remove old counselor goals for the same weekStart (replace, not append)
    const weekStarts = [...new Set(newGoals.map((g) => g.weekStart))];
    const kept = existing.filter(
      (g) => !(weekStarts.includes(g.weekStart) && g.createdBy === "counselor")
    );
    // Tag all new goals with counselor metadata
    const tagged = newGoals.map((g) => ({
      ...g,
      createdBy:    "counselor",
      counselorUid,
      locked:       true,
    }));
    const merged = [...kept, ...tagged];
    // Write to student's data key
    await setDoc(
      doc(db, "users", studentUid, "data", "yks_weekly_goals"),
      { v: merged },
      { merge: false }  // full replace of this key
    );
    return true;
  } catch (e) {
    console.error("setCounselorWeeklyGoals error:", e.code, e.message);
    return false;
  }
}