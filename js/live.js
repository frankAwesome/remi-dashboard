/* ══════════════════════════════════════════════════════════════
   Live data — Firebase Auth + Firestore snapshots.

   The site writes these collections unauthenticated; reading them is a
   different matter, and firestore.rules grants read to exactly one signed-in
   identity. So the dashboard signs you in and subscribes; there is no build
   step, no committed snapshot, and no window during which the page is showing
   yesterday.

   onSnapshot rather than polling, for two reasons. It is genuinely live — a
   download appears the moment the row lands, not on the next tick — and it is
   far cheaper: Firestore bills the first snapshot in full and then only the
   documents that actually changed. Polling four collections every five minutes
   would re-read the entire database 288 times a day and blow the free tier
   before lunch.
   ══════════════════════════════════════════════════════════════ */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getFirestore, collection, onSnapshot, query, orderBy }
  from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

import { COLLECTIONS } from "./aggregate.js";

/* Public by design — it identifies the project, it authorises nothing. Access
   is controlled by firestore.rules, which is why reading needs a sign-in. */
const firebaseConfig = {
  apiKey: "AIzaSyCc5q1QVR5KlV3khzwCryrO0ScB6P-D1xY",
  authDomain: "remidsp-98208.firebaseapp.com",
  projectId: "remidsp-98208",
  storageBucket: "remidsp-98208.firebasestorage.app",
  messagingSenderId: "5196542133",
  appId: "1:5196542133:web:4e67b8c7c9d27c8222cefc",
};

export const GH_REPO = "frankAwesome/remi-amps-downloads";

const app = initializeApp(firebaseConfig, "dashboard");
const auth = getAuth(app);
const db = getFirestore(app);

/* Firebase Auth has to be switched on in the console before any of this works,
   and the error it throws for "not switched on" is a bare configuration-not-found
   that reads like a code bug. Translate it into the actual instruction. */
export const SETUP_ERROR = "auth/configuration-not-found";

export function describeAuthError(e) {
  const code = e?.code || "";
  if (code === SETUP_ERROR || /configuration-not-found/.test(code)) {
    return { setup: true, message: "Firebase Authentication is not switched on yet." };
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return { setup: false, message: "Sign-in cancelled." };
  }
  if (code === "auth/popup-blocked") {
    return { setup: false,
             message: "Your browser blocked the sign-in window — allow popups for this page." };
  }
  if (code === "auth/operation-not-allowed") {
    return { setup: true, message: "The Google sign-in provider is not enabled yet." };
  }
  if (code === "auth/unauthorized-domain") {
    return { setup: true,
             message: `Add ${location.hostname} to Firebase → Authentication → Settings → Authorized domains.` };
  }
  if (code === "permission-denied" || code === "auth/invalid-user-token") {
    return { setup: false,
             message: "Signed in, but this account is not allowed to read the metrics." };
  }
  return { setup: false, message: e?.message || String(e) };
}

export const watchAuth = cb => onAuthStateChanged(auth, cb);

export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

export const leave = () => signOut(auth);

/* Subscribe to all four collections. `onData` fires whenever any of them
   changes, with the full current picture — the caller re-aggregates and
   re-renders, which at this size costs a few milliseconds and keeps the
   render path identical to the one the static build used. */
export function subscribe(onData, onError) {
  const cache = Object.fromEntries(COLLECTIONS.map(c => [c, null]));
  const unsubs = [];

  for (const name of COLLECTIONS) {
    const q = query(collection(db, name), orderBy("ts", "desc"));
    unsubs.push(onSnapshot(q, snap => {
      cache[name] = snap.docs.map(d => {
        const raw = d.data();
        return {
          ...raw,
          // Firestore hands back a Timestamp; everything downstream expects the
          // same RFC3339 string the REST export produced.
          ts: raw.ts?.toDate ? raw.ts.toDate().toISOString() : (raw.ts ?? null),
        };
      });
      // Hold the first render until every collection has answered once,
      // otherwise the page paints with three of four series at zero.
      if (COLLECTIONS.every(c => cache[c] !== null)) {
        onData({ ...cache }, { fromCache: snap.metadata.fromCache });
      }
    }, err => onError?.(err)));
  }

  return () => unsubs.forEach(u => u());
}

/* Public endpoint, no token needed — 60 requests/hour per IP unauthenticated,
   and one dashboard load costs exactly one. */
export async function fetchReleases() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases?per_page=100`,
                        { headers: { accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return r.json();
}
