"use strict";

/**
 * ============================================================================
 *  HealthGPT — Vercel Serverless Backend
 *  Evolution of Asha Plus, simplified to 2 roles: super_admin, user.
 *
 *  Routes:
 *   Auth/Users:     initializeAdmin, selfRegisterUser, createUser,
 *                    updateUserRole, deleteAuthUser, listUsers
 *   AI:              askHealthAssistant (rotating 3-answer cache),
 *                    analyzeMedicalDocument (OCR text -> AI summary)
 *   Govt Schemes:    addScheme, updateScheme, deleteScheme
 *   Reminders:       addReminder, updateReminder, deleteReminder
 *   Calendar Notes:  addCalendarNote, updateCalendarNote, deleteCalendarNote
 * ============================================================================
 */

const express         = require("express");
const cors            = require("cors");
const crypto          = require("crypto");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth }     = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { GoogleGenAI } = require("@google/genai");
const Groq            = require("groq-sdk");
const { InferenceClient } = require("@huggingface/inference");

// ── Firebase Admin init (safe for serverless — only runs once per cold start) ─
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db   = getFirestore();
const auth = getAuth();

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ── Role constants (simplified: only 2 roles in this app) ───────────────────
const ROLES = {
  SUPER_ADMIN: "super_admin",
  USER:        "user",
};

const COL = {
  USERS:          "users",
  SCHEMES:        "govt_schemes",
  CACHE:          "cached_responses",
  REMINDERS:      "reminders",
  CALENDAR_NOTES: "calendar_notes",
};

// =============================================================================
//  SHARED HELPERS
// =============================================================================

/** Verify Firebase ID token from Authorization: Bearer <token> header */
async function verifyToken(req) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return await auth.verifyIdToken(token);
  } catch {
    return null;
  }
}

/** Returns an error object if caller lacks the required role, null if OK */
function checkRole(decoded, ...allowedRoles) {
  if (!decoded) {
    return { code: 401, message: "You must be signed in to do this." };
  }
  if (!allowedRoles.includes(decoded.role)) {
    return {
      code: 403,
      message: `Required role: ${allowedRoles.join(" or ")}. Your role: ${decoded.role || "none"}.`,
    };
  }
  return null;
}

/** Returns an error object if a required field is missing, null if OK */
function checkField(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { code: 400, message: `"${fieldName}" is required.` };
  }
  return null;
}

/** Map internal error codes to HTTP status codes and send response */
function sendError(res, err) {
  if (err && err.code && err.message) {
    return res.status(err.code).json({ error: err.message });
  }
  return res.status(500).json({ error: err?.message || "Internal server error." });
}

// =============================================================================
//  1. INITIALIZE ADMIN  (POST /api/initializeAdmin)
//  Called once via curl/Postman to bootstrap the first super_admin.
// =============================================================================
app.post("/api/initializeAdmin", async (req, res) => {
  const { setupToken, email, password, name } = req.body || {};

  if (!setupToken || setupToken !== process.env.SETUP_TOKEN) {
    return res.status(403).json({ error: "Invalid or missing setup token." });
  }
  if (!email || !password || !name) {
    return res.status(400).json({ error: "email, password, and name are required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existingSnap = await db
    .collection(COL.USERS)
    .where("role", "==", ROLES.SUPER_ADMIN)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    return res.status(409).json({ error: "Super admin already initialized. Use the app to manage users." });
  }

  try {
    const userRecord = await auth.createUser({ email, password, displayName: name });
    await auth.setCustomUserClaims(userRecord.uid, { role: ROLES.SUPER_ADMIN });

    await db.collection(COL.USERS).doc(userRecord.uid).set({
      uid:       userRecord.uid,
      name,
      email,
      role:      ROLES.SUPER_ADMIN,
      mobile:    "",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: "system_bootstrap",
    });

    return res.status(201).json({
      success: true,
      message: "✅ Super admin created. You can now log in via the app.",
      uid:     userRecord.uid,
    });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "This email is already registered in Firebase Auth." });
    }
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
//  2. SELF-REGISTER USER  (POST /api/selfRegisterUser)
//  Called immediately after Firebase Auth signup on the client.
//  Uses the new user's own ID token — no staff role required.
// =============================================================================
app.post("/api/selfRegisterUser", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) {
    return sendError(res, { code: 401, message: "Authentication required. Please try again." });
  }

  const { name, email } = req.body || {};
  const fieldErr = checkField(name, "name") || checkField(email, "email");
  if (fieldErr) return sendError(res, fieldErr);

  const uid = decoded.uid;

  const existingUser = await db.collection(COL.USERS).doc(uid).get();
  if (existingUser.exists) {
    return res.json({ success: true, alreadyExists: true });
  }

  try {
    const userDoc = {
      uid,
      name:      name.trim(),
      email:     email.trim().toLowerCase(),
      role:      ROLES.USER,
      mobile:    "",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: "self_registration",
    };

    await db.collection(COL.USERS).doc(uid).set(userDoc);
    await auth.setCustomUserClaims(uid, { role: ROLES.USER });

    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: "Registration failed: " + err.message });
  }
});

// =============================================================================
//  3. CREATE USER  (POST /api/createUser)
//  super_admin creates another user (regular "user" or another "super_admin").
// =============================================================================
app.post("/api/createUser", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { email, password, name, role = ROLES.USER, mobile = "" } = req.body || {};

  const fieldErr =
    checkField(email,    "email")    ||
    checkField(password, "password") ||
    checkField(name,     "name");
  if (fieldErr) return sendError(res, fieldErr);

  if (password.length < 8) {
    return sendError(res, { code: 400, message: "Password must be at least 8 characters." });
  }

  if (![ROLES.USER, ROLES.SUPER_ADMIN].includes(role)) {
    return sendError(res, { code: 400, message: `Invalid role "${role}". Allowed: user, super_admin.` });
  }

  try {
    const userRecord = await auth.createUser({ email, password, displayName: name });
    await auth.setCustomUserClaims(userRecord.uid, { role });

    await db.collection(COL.USERS).doc(userRecord.uid).set({
      uid:       userRecord.uid,
      name,
      email,
      role,
      mobile,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: decoded.uid,
    });

    return res.status(201).json({ success: true, uid: userRecord.uid });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      return sendError(res, { code: 409, message: "This email is already registered." });
    }
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  4. UPDATE USER ROLE  (POST /api/updateUserRole)  — super_admin only
// =============================================================================
app.post("/api/updateUserRole", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { uid, newRole } = req.body || {};
  const fieldErr = checkField(uid, "uid") || checkField(newRole, "newRole");
  if (fieldErr) return sendError(res, fieldErr);

  if (![ROLES.USER, ROLES.SUPER_ADMIN].includes(newRole)) {
    return sendError(res, { code: 400, message: `Invalid role "${newRole}". Allowed: user, super_admin.` });
  }

  try {
    await auth.setCustomUserClaims(uid, { role: newRole });
    await db.collection(COL.USERS).doc(uid).update({ role: newRole });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  5. DELETE AUTH USER  (POST /api/deleteAuthUser)  — super_admin only
// =============================================================================
app.post("/api/deleteAuthUser", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { uid } = req.body || {};
  const fieldErr = checkField(uid, "uid");
  if (fieldErr) return sendError(res, fieldErr);

  try {
    await auth.deleteUser(uid);
    await db.collection(COL.USERS).doc(uid).delete();
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  6. LIST USERS  (POST /api/listUsers)  — super_admin only
// =============================================================================
app.post("/api/listUsers", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  try {
    const snap = await db.collection(COL.USERS).get();
    return res.json({ users: snap.docs.map((d) => d.data()) });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  GOVERNMENT SCHEMES  — management is super_admin only, everyone can read
//  (reads happen client-side directly via Firestore onSnapshot)
// =============================================================================

app.post("/api/addScheme", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { title, description, category, link, eligibility } = req.body || {};
  const fieldErr = checkField(title, "title");
  if (fieldErr) return sendError(res, fieldErr);

  try {
    const ref = db.collection(COL.SCHEMES).doc();
    await ref.set({
      id:          ref.id,
      title,
      description: description || "",
      category:    category || "",
      link:        link || "",
      eligibility: eligibility || "",
      createdAt:   FieldValue.serverTimestamp(),
      createdBy:   decoded.uid,
    });
    return res.json({ success: true, schemeId: ref.id });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/updateScheme", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { schemeId, updates } = req.body || {};
  const fieldErr = checkField(schemeId, "schemeId") || checkField(updates, "updates");
  if (fieldErr) return sendError(res, fieldErr);

  const safe = { ...updates };
  delete safe.id;
  delete safe.createdAt;
  delete safe.createdBy;

  try {
    await db.collection(COL.SCHEMES).doc(schemeId).update(safe);
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/deleteScheme", async (req, res) => {
  const decoded = await verifyToken(req);
  const authErr = checkRole(decoded, ROLES.SUPER_ADMIN);
  if (authErr) return sendError(res, authErr);

  const { schemeId } = req.body || {};
  const fieldErr = checkField(schemeId, "schemeId");
  if (fieldErr) return sendError(res, fieldErr);

  try {
    await db.collection(COL.SCHEMES).doc(schemeId).delete();
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  REMINDERS  — every signed-in user manages their own (super_admin or user).
//  Reads happen client-side via Firestore onSnapshot, filtered by
//  where("userId", "==", uid). Writes go through here so ownership is
//  always enforced server-side.
// =============================================================================

app.post("/api/addReminder", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { text, mode, date, time, everyHrs, everyMin } = req.body || {};
  const fieldErr = checkField(text, "text") || checkField(mode, "mode");
  if (fieldErr) return sendError(res, fieldErr);

  if (mode === "once" && (!date || !time)) {
    return sendError(res, { code: 400, message: "date and time are required for a one-time reminder." });
  }
  if (mode === "interval" && !(Number(everyHrs) || Number(everyMin))) {
    return sendError(res, { code: 400, message: "everyHrs and/or everyMin is required for a recurring reminder." });
  }

  try {
    const ref = db.collection(COL.REMINDERS).doc();
    await ref.set({
      id:        ref.id,
      userId:    decoded.uid,
      text:      String(text).trim(),
      mode,
      date:      date || "",
      time:      time || "",
      everyHrs:  everyHrs || "",
      everyMin:  everyMin || "",
      done:      false,
      paused:    false,
      lastFired: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, reminderId: ref.id });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/updateReminder", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { reminderId, updates } = req.body || {};
  const fieldErr = checkField(reminderId, "reminderId") || checkField(updates, "updates");
  if (fieldErr) return sendError(res, fieldErr);

  const ref  = db.collection(COL.REMINDERS).doc(reminderId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, { code: 404, message: "Reminder not found." });
  if (snap.data().userId !== decoded.uid && decoded.role !== ROLES.SUPER_ADMIN) {
    return sendError(res, { code: 403, message: "You can only edit your own reminders." });
  }

  const safe = { ...updates };
  delete safe.id;
  delete safe.userId;
  delete safe.createdAt;

  try {
    await ref.update(safe);
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/deleteReminder", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { reminderId } = req.body || {};
  const fieldErr = checkField(reminderId, "reminderId");
  if (fieldErr) return sendError(res, fieldErr);

  const ref  = db.collection(COL.REMINDERS).doc(reminderId);
  const snap = await ref.get();
  if (!snap.exists) return res.json({ success: true }); // already gone
  if (snap.data().userId !== decoded.uid && decoded.role !== ROLES.SUPER_ADMIN) {
    return sendError(res, { code: 403, message: "You can only delete your own reminders." });
  }

  try {
    await ref.delete();
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  CALENDAR NOTES  — one doc per (user, date). Doc ID = `${uid}_${date}`.
//  doc shape: { userId, date, notes: [string, ...] }
// =============================================================================

function calNoteDocId(uid, date) {
  return `${uid}_${date}`;
}

app.post("/api/addCalendarNote", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { date, text } = req.body || {};
  const fieldErr = checkField(date, "date") || checkField(text, "text");
  if (fieldErr) return sendError(res, fieldErr);

  const ref = db.collection(COL.CALENDAR_NOTES).doc(calNoteDocId(decoded.uid, date));

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, {
          userId:    decoded.uid,
          date,
          notes:     [String(text).trim()],
          createdAt: FieldValue.serverTimestamp(),
        });
      } else {
        const notes = [...(snap.data().notes || []), String(text).trim()];
        tx.update(ref, { notes });
      }
    });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/updateCalendarNote", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { date, index, text } = req.body || {};
  const fieldErr = checkField(date, "date") || checkField(text, "text");
  if (fieldErr) return sendError(res, fieldErr);
  if (index === undefined || index === null || index < 0) {
    return sendError(res, { code: 400, message: '"index" is required and must be >= 0.' });
  }

  const ref = db.collection(COL.CALENDAR_NOTES).doc(calNoteDocId(decoded.uid, date));

  try {
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, { code: 404, message: "No notes found for this date." });
    const notes = [...(snap.data().notes || [])];
    if (index >= notes.length) return sendError(res, { code: 400, message: "Note index out of range." });
    notes[index] = String(text).trim();
    await ref.update({ notes });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

app.post("/api/deleteCalendarNote", async (req, res) => {
  const decoded = await verifyToken(req);
  if (!decoded) return sendError(res, { code: 401, message: "Authentication required." });

  const { date, index } = req.body || {};
  const fieldErr = checkField(date, "date");
  if (fieldErr) return sendError(res, fieldErr);
  if (index === undefined || index === null || index < 0) {
    return sendError(res, { code: 400, message: '"index" is required and must be >= 0.' });
  }

  const ref = db.collection(COL.CALENDAR_NOTES).doc(calNoteDocId(decoded.uid, date));

  try {
    const snap = await ref.get();
    if (!snap.exists) return res.json({ success: true }); // already gone
    const notes = (snap.data().notes || []).filter((_, i) => i !== index);
    if (notes.length === 0) {
      await ref.delete();
    } else {
      await ref.update({ notes });
    }
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, { code: 500, message: err.message });
  }
});

// =============================================================================
//  ASHA AI HEALTH ASSISTANT  (POST /api/askHealthAssistant)
//  MEDICAL DOCUMENT ANALYSIS (POST /api/analyzeMedicalDocument)
//  Cache-first, 3-provider fallback chain — all free tiers:
//  Gemini → Groq → HuggingFace
//
//  ROTATING-ANSWER CACHE (new for this app):
//  Each cached question stores UP TO 3 answer variants + an ask counter.
//    Ask #1 → generate & store variant 1, return it
//    Ask #2 → generate & store variant 2, return it
//    Ask #3 → generate & store variant 3, return it
//    Ask #4 → cycle back to variant 1 (no new AI call)
//    Ask #5 → variant 2, Ask #6 → variant 3, Ask #7 → variant 1, etc.
// =============================================================================

const AI_SYSTEM_PROMPT = `You are Asha AI, a friendly and knowledgeable health assistant for HealthGPT. You help users understand symptoms, medicines, and general health tips. You support both English and Hindi — always reply in the same language the user writes in.

════════════════════════════════════════
RESPONSE FORMAT — MANDATORY STRUCTURE
════════════════════════════════════════

For every health condition, symptom, or wellness topic, you MUST structure your response in exactly these 4 sections in this order:

---

## 🩺 [Condition Name] — [Short Tagline]

---

### ✅ Key Instructions (5–6 points)
Give exactly 5 to 6 numbered, practical lifestyle and management tips.
- Each point must be one clear, actionable sentence.
- No vague advice. Be specific (e.g., "Walk briskly for 30 minutes daily" not just "Exercise").
- In Hindi queries, write tips in Hindi. In English queries, write in English.

---

### 💊 Commonly Used Medicines
List 3 to 4 medicines most commonly prescribed for this condition.
For each medicine provide: Name (generic), Drug class / category, One-line note on what it does.
Always end this section with this exact disclaimer line:
"⚠️ For reference only. Never take any medicine without a doctor's prescription."

Format:
| Medicine | Drug Class | Purpose |
|----------|-----------|---------|
| [Name] | [Class] | [One-line use] |

---

### 🚨 Doctor Caution
Write 2–3 specific warning signs that mean the user must see a doctor immediately.
Be specific to the condition — do NOT use generic warnings.
Always end with: "Do not self-medicate. Consult a qualified doctor."

---

════════════════════════════════════════
LANGUAGE RULES
════════════════════════════════════════
- If user writes in Hindi → respond fully in Hindi (Devanagari script).
- If user writes in English → respond fully in English.
- If user mixes both → match the dominant language used.

════════════════════════════════════════
TONE & SAFETY RULES
════════════════════════════════════════
- Be warm, clear, and easy to understand. Avoid medical jargon.
- Never diagnose a user. You provide general health information only.
- Never recommend a specific dosage or say a medicine is "safe" without a prescription.
- If the question is about a mental health crisis, emergency, or severe symptoms — skip the format and immediately say: "Please call emergency services or visit the nearest hospital right away."
- Do not make up medicines or invent drug names. Only mention real, well-known generic medicines.
- If a condition is too specific or rare to give general medicine info, skip the medicine section and explain why briefly.

════════════════════════════════════════
SCOPE RESTRICTION — MANDATORY, NO EXCEPTIONS
════════════════════════════════════════
You ONLY answer questions about: physical health, mental health, diseases, symptoms, medicines, nutrition/diet, yoga, exercise, hygiene, maternal & child health, first aid, and general wellness.

If the user asks about ANYTHING else — movies, actors, celebrities, sports, politics, coding, homework, exams, general trivia, finance, gaming, astrology, etc. — do NOT answer it, even partially, and do NOT use the 4-section format. Reply with ONLY this line (in the user's language):

"Sorry, Asha AI can only help with health, medicine, nutrition, yoga, and general wellness questions. Please ask something related to your health."

Do not explain why, do not apologize further, do not add anything else.`;

// ── Off-topic guard — runs BEFORE cache lookup and BEFORE any AI provider
// call, so an obviously off-topic prompt never spends a token or a read. ────

const OFF_TOPIC_KEYWORDS = [
  "movie", "film", "actor", "actress", "bollywood", "hollywood", "song lyrics",
  "lyrics", "singer", "album", "netflix", "web series", "tv show", "celebrity",
  "cricket", "football match", "ipl", "match score", "world cup", "olympics",
  "kabaddi", "wwe", "fifa",
  "election", "politician", "prime minister", "president of", "parliament",
  "political party", "bjp", "congress party",
  "programming", "javascript", "python code", "source code", "algorithm",
  "homework", "exam question", "maths problem", "write an essay", "assignment",
  "joke", "riddle", "horoscope", "astrology", "cryptocurrency", "bitcoin",
  "stock market", "share price", "video game", "gaming pc",
];

const HEALTH_KEYWORDS = [
  "pain", "fever", "cough", "cold", "medicine", "medicin", "tablet", "dose",
  "doctor", "hospital", "disease", "diabetes", "bp", "blood pressure",
  "pregnan", "vaccine", "injection", "symptom", "health", "diet", "food",
  "nutrition", "yoga", "exercise", "workout", "mental health", "stress",
  "anxiety", "depression", "sleep", "infection", "allergy", "injury", "wound",
  "cancer", "heart", "lungs", "kidney", "liver", "stomach", "vomit",
  "diarrhea", "headache", "weight loss", "obesity", "child health", "baby",
  "delivery", "period", "menstru", "vitamin", "supplement", "surgery",
  "therapy", "hygiene", "first aid", "बीमारी", "दवा", "स्वास्थ्य",
  "बुखार", "दर्द", "योग", "आहार",
];

function isLikelyOffTopic(promptRaw) {
  const p = promptRaw.toLowerCase();
  const hasHealthSignal = HEALTH_KEYWORDS.some((kw) => p.includes(kw));
  if (hasHealthSignal) return false;
  return OFF_TOPIC_KEYWORDS.some((kw) => p.includes(kw));
}

function offTopicReply(promptRaw) {
  const isHindi = /[\u0900-\u097F]/.test(promptRaw);
  return isHindi
    ? "क्षमा करें, Asha AI केवल स्वास्थ्य, दवाइयों, पोषण, योग और सामान्य स्वास्थ्य से जुड़े सवालों में मदद कर सकती है। कृपया कोई स्वास्थ्य से जुड़ा सवाल पूछें।"
    : "Sorry, Asha AI can only help with health, medicine, nutrition, yoga, and general wellness questions. Please ask something related to your health.";
}

function normalizePrompt(rawPrompt) {
  const cleaned = rawPrompt.trim().toLowerCase();
  const slug = cleaned
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const hash = crypto.createHash("md5").update(cleaned).digest("hex").slice(0, 10);
  return slug ? `${slug}_${hash}` : hash;
}

function hashOf(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

// ── Provider callers ──────────────────────────────────────────────────────

async function callGemini(systemPrompt, userPrompt) {
  const ai     = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await ai.models.generateContent({
    model:    "gemini-2.5-flash",
    contents: userPrompt,
    config:   { systemInstruction: systemPrompt },
  });
  const text = result.text;
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

async function callGroq(systemPrompt, userPrompt) {
  const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
  });
  const text = completion.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned an empty response");
  return text;
}

async function callHuggingFace(systemPrompt, userPrompt) {
  const hf         = new InferenceClient(process.env.HF_TOKEN);
  const completion = await hf.chatCompletion({
    model:      "meta-llama/Llama-3.1-8B-Instruct",
    messages:   [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    max_tokens: 512,
  });
  const text = completion.choices?.[0]?.message?.content;
  if (!text) throw new Error("Hugging Face returned an empty response");
  return text;
}

const PROVIDER_CHAIN = [
  { name: "gemini",      envKey: "GEMINI_API_KEY", call: callGemini },
  { name: "groq",        envKey: "GROQ_API_KEY",   call: callGroq },
  { name: "huggingface", envKey: "HF_TOKEN",       call: callHuggingFace },
];

/**
 * Tries every configured provider in PROVIDER_CHAIN order.
 * Skips providers whose env var isn't set. Returns { text, source }.
 * Throws only if every configured provider failed.
 */
async function runWithFallback(systemPrompt, userPrompt) {
  let lastErr = null;
  let triedAny = false;

  for (const provider of PROVIDER_CHAIN) {
    if (!process.env[provider.envKey]) continue;
    triedAny = true;
    try {
      const text = await provider.call(systemPrompt, userPrompt);
      return { text, source: provider.name };
    } catch (err) {
      console.warn(`${provider.name} failed:`, err.message);
      lastErr = err;
    }
  }

  if (!triedAny) {
    throw new Error(
      "No AI provider API keys are configured on the server (checked GEMINI_API_KEY, GROQ_API_KEY, HF_TOKEN)."
    );
  }
  throw lastErr || new Error("All configured AI providers failed.");
}

const MAX_ANSWER_VARIANTS = 3;

/**
 * Generates a fresh answer variant that's meaningfully different in
 * phrasing/structure from any previously stored variants for this question,
 * while keeping medical accuracy identical.
 */
async function generateVariant(userPrompt, previousVariants) {
  let systemPrompt = AI_SYSTEM_PROMPT;
  if (previousVariants.length > 0) {
    systemPrompt +=
      `\n\n════════════════════════════════════════\n` +
      `VARIATION REQUIREMENT\n` +
      `════════════════════════════════════════\n` +
      `The user has asked this same question before. You MUST still follow the ` +
      `4-section format exactly, and the medical facts must stay accurate and ` +
      `consistent — but reword the wording, sentence structure, and ordering of ` +
      `tips so this reply doesn't read identically to your earlier answer(s) below. ` +
      `Do not just shuffle a few words; genuinely rephrase.\n\n` +
      `Previous answer(s) to avoid repeating verbatim:\n` +
      previousVariants.map((v, i) => `--- Previous variant ${i + 1} ---\n${v}`).join("\n\n");
  }
  return runWithFallback(systemPrompt, userPrompt);
}

app.post("/api/askHealthAssistant", async (req, res) => {
  const userPrompt = (req.body?.prompt || "").trim();
  if (!userPrompt) {
    return sendError(res, { code: 400, message: 'Please send a non-empty "prompt".' });
  }

  if (isLikelyOffTopic(userPrompt)) {
    return res.json({ response: offTopicReply(userPrompt), source: "guard" });
  }

  const cacheId  = normalizePrompt(userPrompt);
  const cacheRef = db.collection(COL.CACHE).doc(cacheId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(cacheRef);

      if (!snap.exists) {
        // First time this question has ever been asked.
        const ai = await generateVariant(userPrompt, []);
        tx.set(cacheRef, {
          variants:       [ai.text],
          askCount:       1,
          originalPrompt: userPrompt,
          lastProvider:   ai.source,
          createdAt:      FieldValue.serverTimestamp(),
          updatedAt:      FieldValue.serverTimestamp(),
        });
        return { text: ai.text, source: ai.source };
      }

      const data     = snap.data();
      const variants = data.variants || [];
      const askCount = (data.askCount || 0) + 1;
      const slot     = (askCount - 1) % MAX_ANSWER_VARIANTS; // 0,1,2,0,1,2,...

      if (slot < variants.length) {
        // We already have this slot's variant — return it, no AI call.
        tx.update(cacheRef, { askCount, updatedAt: FieldValue.serverTimestamp() });
        return { text: variants[slot], source: "cache" };
      }

      // Need to generate the next new variant (slot === variants.length).
      const ai = await generateVariant(userPrompt, variants);
      const nextVariants = [...variants, ai.text];
      tx.update(cacheRef, {
        variants:     nextVariants,
        askCount,
        lastProvider: ai.source,
        updatedAt:    FieldValue.serverTimestamp(),
      });
      return { text: ai.text, source: ai.source };
    });

    return res.json({ response: result.text, source: result.source });
  } catch (e) {
    console.error("askHealthAssistant failed:", e.message);
    return sendError(res, {
      code:    503,
      message: "Asha AI couldn't reach any provider right now. Please try again shortly.",
    });
  }
});

app.post("/api/analyzeMedicalDocument", async (req, res) => {
  const systemPrompt = (req.body?.systemPrompt || "").trim();
  const ocrText      = (req.body?.ocrText || "").trim();

  if (!systemPrompt || !ocrText) {
    return sendError(res, {
      code:    400,
      message: 'Please send a non-empty "systemPrompt" and "ocrText".',
    });
  }

  const userPrompt =
    `Here is the OCR-extracted text from the uploaded image. Analyze it and ` +
    `reply using the required structure only — no extra commentary:\n\n"""\n${ocrText}\n"""`;

  // Document analysis stays single-answer (not rotated) — same doc re-analyzed
  // should give a consistent summary rather than a "different" one each time.
  const cacheId  = "doc_" + hashOf(systemPrompt + "::" + ocrText);
  const cacheRef = db.collection(COL.CACHE).doc(cacheId);

  try {
    const snap = await cacheRef.get();
    if (snap.exists) {
      return res.json({ response: snap.data().response, source: "cache" });
    }
  } catch (err) {
    console.warn("Cache read failed — continuing to live AI call:", err.message);
  }

  let result;
  try {
    result = await runWithFallback(systemPrompt, userPrompt);
  } catch (e) {
    console.error("All AI providers failed for document analysis:", e.message);
    return sendError(res, {
      code:    503,
      message: "AI analysis couldn't reach any provider right now. Please try again shortly.",
    });
  }

  try {
    await cacheRef.set({
      response:  result.text,
      provider:  result.source,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn("Cache write failed (response still returned):", err.message);
  }

  return res.json({ response: result.text, source: result.source });
});

// ── Export for Vercel ─────────────────────────────────────────────────────
module.exports = app;
