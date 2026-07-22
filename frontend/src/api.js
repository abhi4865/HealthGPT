/**
 * ============================================================================
 *  HealthGPT — Vercel API Client
 *  All backend calls go through here. Auth token is automatically attached.
 * ============================================================================
 */

import { auth } from "./firebaseConfig";

const BASE_URL =
  import.meta.env.VITE_API_URL || "https://your-new-backend.vercel.app";

// ── Core fetch helper — attaches Firebase ID token automatically ─────────────
async function apiFetch(endpoint, body) {
  const token = await auth.currentUser?.getIdToken();
  const res   = await fetch(`${BASE_URL}${endpoint}`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Self-Registration (no existing session needed — uses fresh signup token) ──

/**
 * Called right after createUserWithEmailAndPassword succeeds.
 * Pass the raw ID token from cred.user.getIdToken() directly,
 * since auth.currentUser may not be set yet when this runs.
 */
export async function selfRegisterUser(idToken, { name, email }) {
  const res  = await fetch(`${BASE_URL}/api/selfRegisterUser`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${idToken}`,
    },
    body: JSON.stringify({ name, email }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Registration failed");
  return data; // { success }
}

// ── Auth & User Management (super_admin only) ─────────────────────────────────

export const createUser = (payload) =>
  apiFetch("/api/createUser", payload);
  // payload: { email, password, name, role?, mobile? }  role: "user" | "super_admin"

export const updateUserRole = (uid, newRole) =>
  apiFetch("/api/updateUserRole", { uid, newRole });

export const deleteAuthUser = (uid) =>
  apiFetch("/api/deleteAuthUser", { uid });

export const listUsers = () =>
  apiFetch("/api/listUsers", {});

// ── Government Schemes (management: super_admin only) ─────────────────────────

export const addScheme = (scheme) =>
  apiFetch("/api/addScheme", scheme);
  // scheme: { title, description?, category?, link?, eligibility? }

export const updateScheme = (schemeId, updates) =>
  apiFetch("/api/updateScheme", { schemeId, updates });

export const deleteScheme = (schemeId) =>
  apiFetch("/api/deleteScheme", { schemeId });

// ── AI Health Assistant ───────────────────────────────────────────────────────

export const askHealthAssistant = (prompt) =>
  apiFetch("/api/askHealthAssistant", { prompt });
  // returns: { response: string, source: "gemini"|"groq"|"huggingface"|"cache" }
  // Same question rotates through up to 3 stored answer variants automatically —
  // no extra params needed here, the backend tracks the ask count per question.

// ── Medical Analysis (OCR text → AI summary) ──────────────────────────────────

export const analyzeMedicalDocument = (systemPrompt, ocrText) =>
  apiFetch("/api/analyzeMedicalDocument", { systemPrompt, ocrText });
  // returns: { response: string, source: "gemini"|"groq"|"huggingface"|"cache" }
  // Only the OCR-extracted TEXT is sent — never the image — to keep cost low.

// ── Reminders ──────────────────────────────────────────────────────────────────
// Reads happen client-side via Firestore onSnapshot (see App.jsx), filtered
// to the signed-in user's own reminders. Writes go through the backend so
// ownership is always verified server-side.

export const addReminder = (reminder) =>
  apiFetch("/api/addReminder", reminder);
  // reminder: { text, mode: "once"|"interval", date?, time?, everyHrs?, everyMin? }

export const updateReminder = (reminderId, updates) =>
  apiFetch("/api/updateReminder", { reminderId, updates });

export const deleteReminder = (reminderId) =>
  apiFetch("/api/deleteReminder", { reminderId });

// ── Calendar Notes ───────────────────────────────────────────────────────────
// One Firestore doc per (user, date). Reads via onSnapshot in App.jsx.

export const addCalendarNote = (date, text) =>
  apiFetch("/api/addCalendarNote", { date, text });

export const updateCalendarNote = (date, index, text) =>
  apiFetch("/api/updateCalendarNote", { date, index, text });

export const deleteCalendarNote = (date, index) =>
  apiFetch("/api/deleteCalendarNote", { date, index });