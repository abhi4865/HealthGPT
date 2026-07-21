/**
 * ============================================================================
 *  HealthGPT — Vercel API Client
 *  All backend calls go through here. Auth token is automatically attached.
 * ============================================================================
 */

import { auth } from "./firebaseConfig";

const BASE_URL =
  import.meta.env.VITE_API_URL || "https://asha-care-eight.vercel.app";

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
export async function selfRegisterPatient(idToken, { name, email }) {
  const res  = await fetch(`${BASE_URL}/api/selfRegisterPatient`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${idToken}`,
    },
    body: JSON.stringify({ name, email }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Registration failed");
  return data; // { success, patientId }
}

// ── Auth & User Management ────────────────────────────────────────────────────

export const createUser = (payload) =>
  apiFetch("/api/createUser", payload);
  // payload: { email, password, name, role, mobile?, location? }

export const updateUserRole = (uid, newRole) =>
  apiFetch("/api/updateUserRole", { uid, newRole });

export const updateAshaWorker = (uid, updates) =>
  apiFetch("/api/updateAshaWorker", { uid, updates });
  // updates: { name?, mobile?, location?, email? } — super_admin only

export const deleteAuthUser = (uid) =>
  apiFetch("/api/deleteAuthUser", { uid });

export const listUsers = () =>
  apiFetch("/api/listUsers", {});

// ── Patients ─────────────────────────────────────────────────────────────────

export const adminCreatePatient = (payload) =>
  apiFetch("/api/adminCreatePatient", payload);
  // payload: { name, email, password, mobile?, age?, gender?, village?, ... }
  // Creates Firebase Auth user + users doc + patients doc atomically (admin/asha only)

export const addPatient = (patient) =>
  apiFetch("/api/addPatient", patient);
  // patient: { name, mobile, age?, gender?, blood?, email?, village?, state?, diseases? }

export const updatePatient = (patientId, updates) =>
  apiFetch("/api/updatePatient", { patientId, updates });

export const deletePatient = (patientId) =>
  apiFetch("/api/deletePatient", { patientId });

// ── Visit History ─────────────────────────────────────────────────────────────

export const addVisit = (patientId, visit) =>
  apiFetch("/api/addVisit", { patientId, visit });

export const updateVisit = (patientId, visitId, updates) =>
  apiFetch("/api/updateVisit", { patientId, visitId, updates });

export const deleteVisit = (patientId, visitId) =>
  apiFetch("/api/deleteVisit", { patientId, visitId });

// ── Government Schemes ────────────────────────────────────────────────────────

export const addScheme = (scheme) =>
  apiFetch("/api/addScheme", scheme);

export const updateScheme = (schemeId, updates) =>
  apiFetch("/api/updateScheme", { schemeId, updates });

export const deleteScheme = (schemeId) =>
  apiFetch("/api/deleteScheme", { schemeId });

// ── AI Health Assistant ───────────────────────────────────────────────────────

export const askHealthAssistant = (prompt) =>
  apiFetch("/api/askHealthAssistant", { prompt });
  // returns: { response: string, source: "gemini"|"groq"|"huggingface"|"cache" }

// ── Medical Analysis (OCR text → AI summary) ──────────────────────────────────

export const analyzeMedicalDocument = (systemPrompt, ocrText) =>
  apiFetch("/api/analyzeMedicalDocument", { systemPrompt, ocrText });
  // returns: { response: string, source: "gemini"|"groq"|"huggingface"|"cache" }
  // Only the OCR-extracted TEXT is sent — never the image — to keep cost low.