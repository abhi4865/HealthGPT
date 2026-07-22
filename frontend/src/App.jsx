import { useState, useEffect, createContext, useContext, useRef } from "react";
import { createPortal } from "react-dom";
import html2pdf from "html2pdf.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
} from "firebase/firestore";
import { auth, db } from "./firebaseConfig";
import {
  askHealthAssistant,
  analyzeMedicalDocument,
  createUser,
  deleteAuthUser,
  updateAshaWorker,
  selfRegisterPatient,
} from "./api";
// Note: direct patient add/edit/delete (addPatient/updatePatient/
// deletePatient/adminCreatePatient) stay disabled since the Dashboard/
// Patients pages were removed. Registration below creates a real Firebase
// Auth account + patient record via selfRegisterPatient.
import "./App.css";

// ─── Auth Context ────────────────────────────────────────────────────────────
const AuthContext = createContext(null);
const useAuth = () => useContext(AuthContext);

// ─── Security / Password Config (still used by Manage Admin Profile UI) ─────
const SECURITY_QUESTIONS = [
  "What was the name of your first school?",
  "What is your mother's maiden name?",
  "What was the name of your first pet?",
  "What city were you born in?",
  "Which ASHA center did you start your career at?",
];

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS  = 15 * 60 * 1000; // 15 minutes

function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: "Weak", cls: "weak", pct: 25 };
  if (score <= 3) return { label: "Medium", cls: "medium", pct: 60 };
  return { label: "Strong", cls: "strong", pct: 100 };
}

// ─── Icons (emoji-based, no deps) ────────────────────────────────────────────
const Icon = ({ e, size }) => (
  <span style={{ fontSize: size || 16, lineHeight: 1 }}>{e}</span>
);

// ─── Toast Component ─────────────────────────────────────────────────────────
function Toast({ toasts, dismiss }) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismiss(t.id)}>
          <Icon e={t.type === "success" ? "✅" : t.type === "error" ? "❌" : "⚠️"} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{t.title}</div>
            {t.msg && <div style={{ fontSize: 12, color: "#6B7280" }}>{t.msg}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = (title, type = "success", msg = "") => {
    const id = Date.now();
    setToasts((p) => [...p, { id, title, type, msg }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3500);
  };
  const dismiss = (id) => setToasts((p) => p.filter((t) => t.id !== id));
  return { toasts, add, dismiss };
}

// ─── Auth Page ────────────────────────────────────────────────────────────────
// Demo shortcut: test@gmail.com / @test1234 logs straight in with no Firebase
// round trip. Any other email/password goes through real Firebase Auth —
// and Register creates a real Firebase Auth account + patient record.
const DEMO_EMAIL    = "test@gmail.com";
const DEMO_PASSWORD = "@test1234";

function AuthPage({ onLogin, onLoginStart, onLoginEnd }) {
  const [mode, setMode] = useState("login"); // "login" | "register"

  // Shared
  const [email, setEmail]     = useState("");
  const [password, setPass]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [showPass, setShowP]  = useState(false);
  const [showForgotMsg, setShowForgotMsg] = useState(false);

  // Register-only
  const [name, setName]           = useState("");
  const [confirmPass, setConfirm] = useState("");

  const resetFields = () => {
    setError(""); setPass(""); setConfirm(""); setShowForgotMsg(false);
  };

  const switchMode = (next) => { setMode(next); resetFields(); };

  // ── Login ──────────────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e?.preventDefault();
    setError("");

    // Demo/local shortcut — instant, no Firebase round trip.
    if (email.trim() === DEMO_EMAIL && password === DEMO_PASSWORD) {
      setLoading(true);
      setTimeout(() => {
        onLogin({ name: "Test User", email: DEMO_EMAIL, role: "admin" });
        setLoading(false);
      }, 300);
      return;
    }

    setLoading(true);
    onLoginStart?.();
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      await cred.user.getIdToken(true); // refresh so role claim is present
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      if (!snap.exists()) throw new Error("No profile found for this account.");
      onLogin(snap.data());
    } catch (err) {
      setError(err.message?.replace(/^Firebase:\s*/, "") || "Login failed.");
    } finally {
      setLoading(false);
      onLoginEnd?.();
    }
  };

  // ── Register (self-service patient signup) ──────────────────────────────────
  const handleRegister = async (e) => {
    e?.preventDefault();
    setError("");

    if (!name.trim())            return setError("Please enter your full name.");
    if (password.length < 6)     return setError("Password must be at least 6 characters.");
    if (password !== confirmPass) return setError("Passwords do not match.");

    setLoading(true);
    onLoginStart?.();
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken();
      await selfRegisterPatient(idToken, { name: name.trim(), email: email.trim() });
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      onLogin(
        snap.exists()
          ? snap.data()
          : { name: name.trim(), email: email.trim(), role: "patient" }
      );
    } catch (err) {
      setError(err.message?.replace(/^Firebase:\s*/, "") || "Registration failed.");
    } finally {
      setLoading(false);
      onLoginEnd?.();
    }
  };

  const isRegister = mode === "register";

  return (
    <div className="login-page login-page-centered">
      {/* ── Centered Form Panel ── */}
      <div className="login-right">
        <div className="login-form-panel">
          {/* Brand */}
          <div className="login-brand">
            <div className="login-brand-title">HealthGPT</div>
          </div>

          <div className="login-subtitle">
            {isRegister ? (
              <span className="login-link" style={{ textDecoration: "underline" }}>
                Create a new account
              </span>
            ) : (
              "Login with your email and password"
            )}
          </div>

          <form onSubmit={isRegister ? handleRegister : handleLogin} style={{ width: "100%" }}>
            {/* Full Name — register only */}
            {isRegister && (
              <div className="login-field">
                <input
                  className="login-input"
                  type="text"
                  placeholder="Full Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}

            {/* Email */}
            <div className="login-field">
              <input
                className="login-input"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {/* Password */}
            <div className="login-field" style={{ position: "relative" }}>
              <input
                className="login-input"
                type={showPass ? "text" : "password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPass(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowP((p) => !p)}
                style={{
                  position: "absolute", right: 16, top: "50%",
                  transform: "translateY(-50%)",
                  background: "none", border: "none",
                  cursor: "pointer", fontSize: 16, color: "rgba(109,40,217,0.5)",
                }}
              >
                {showPass ? "🙈" : "👁️"}
              </button>
            </div>

            {/* Confirm Password — register only */}
            {isRegister && (
              <div className="login-field">
                <input
                  className="login-input"
                  type={showPass ? "text" : "password"}
                  placeholder="Confirm Password"
                  value={confirmPass}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
            )}

            {/* Forgot password — login only */}
            {!isRegister && (
              <div style={{ textAlign: "right", marginBottom: showForgotMsg ? 10 : 20 }}>
                <span className="login-link" onClick={() => setShowForgotMsg((p) => !p)}>
                  Forgot Password?
                </span>
              </div>
            )}

            {!isRegister && showForgotMsg && (
              <div className="login-demo-creds" style={{ marginBottom: 20 }}>
                Password reset isn't available in this build. Use the demo
                account: {DEMO_EMAIL} / {DEMO_PASSWORD}
              </div>
            )}

            {/* Error */}
            {error && <div className="login-error">{error}</div>}

            {/* Submit button */}
            <button type="submit" className="login-btn" disabled={loading} style={isRegister ? { marginTop: 8 } : undefined}>
              {loading ? <span className="spinner" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,0.3)" }} /> : null}
              {loading ? (isRegister ? "Creating account…" : "Signing in…") : (isRegister ? "Register" : "Login")}
            </button>
          </form>

          {/* Switch mode */}
          <div style={{ marginTop: 18, fontSize: 14 }}>
            {isRegister ? (
              <>
                Already have an account?{" "}
                <span className="login-link" style={{ fontWeight: 700, textDecoration: "underline" }} onClick={() => switchMode("login")}>
                  Login
                </span>
              </>
            ) : (
              <>
                Don't have an account?{" "}
                <span className="login-link" style={{ fontWeight: 700, textDecoration: "underline" }} onClick={() => switchMode("register")}>
                  Register
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
// Custom clipboard logo used for "Medical Analysis" — rendered inline so it
// stays crisp at any size and needs no extra image file/request.
function ClipboardLogoIcon({ size = 20, style }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <rect x="12" y="14" width="40" height="46" rx="4" fill="#d2a679" stroke="#231f20" strokeWidth="2" strokeLinejoin="round" />
      <rect x="18" y="24" width="28" height="32" fill="#ffffff" stroke="#231f20" strokeWidth="2" strokeLinejoin="round" />
      <line x1="23" y1="30" x2="41" y2="30" stroke="#231f20" strokeWidth="2" strokeLinecap="round" />
      <line x1="23" y1="36" x2="41" y2="36" stroke="#231f20" strokeWidth="2" strokeLinecap="round" />
      <line x1="23" y1="42" x2="41" y2="42" stroke="#231f20" strokeWidth="2" strokeLinecap="round" />
      <line x1="23" y1="48" x2="31" y2="48" stroke="#231f20" strokeWidth="2" strokeLinecap="round" />
      <rect x="22" y="10" width="20" height="12" rx="2" fill="#e6e6e6" stroke="#231f20" strokeWidth="2" strokeLinejoin="round" />
      <path d="M 28 10 V 6 C 28 3 36 3 36 6 V 10" fill="none" stroke="#231f20" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="16" r="1.5" fill="#231f20" />
    </svg>
  );
}

const ADMIN_NAV = [
  { key: "chatbot",   icon: "🤖", label: "AI Assistant" },
  { key: "medical",   icon: <ClipboardLogoIcon />, label: "Medical Analysis" },
  { key: "reminder",  icon: "⏰", label: "Reminder" },
  { key: "calendar",  icon: "🗓️", label: "Calendar Note" },
  { key: "schemes",   icon: "🏛️", label: "Govt Schemes" },
];

const PATIENT_NAV = [
  { key: "profile",  icon: "👤", label: "My Profile" },
  { key: "records",  icon: "📋", label: "Health Records" },
  { key: "chatbot",  icon: "🤖", label: "AI Health Guide" },
  { key: "medical",  icon: <ClipboardLogoIcon />, label: "Medical Analysis" },
  { key: "schemes",  icon: "🏛️", label: "Govt Scheme Suggestions" },
];

function Sidebar({ user, active, onNav, mobileOpen, onOverlayClick, collapsed, onToggleCollapse, patientCount }) {
  const isStaff = user.role === "admin" || user.role === "super_admin" || user.role === "asha";
  const nav = isStaff
    ? ADMIN_NAV.map((item) => item.key === "patients" ? { ...item, badge: String(patientCount) } : item)
    : PATIENT_NAV;

  return (
    <>
      <div className={`sidebar-overlay ${mobileOpen ? "active" : ""}`} onClick={onOverlayClick} />
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}>

        {/* ── Brand + Hamburger Toggle ── */}
        <div className="sidebar-brand">
          {!collapsed && (
            <div className="brand-card" onClick={() => onNav(nav[0].key)}>
              <div className="brand-title">HealthGPT</div>
            </div>
          )}
          {/* Hamburger / collapse button */}
          <button
            className="sidebar-hamburger"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </button>
        </div>

        {/* ── Nav ── */}
        <nav className="sidebar-nav">
          {!collapsed && <div className="nav-label">Menu</div>}
          {nav.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${active === item.key ? "active" : ""} ${collapsed ? "nav-item-collapsed" : ""}`}
              onClick={() => onNav(item.key)}
              title={collapsed ? item.label : ""}
            >
              <span className="nav-icon">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="nav-label-text">{item.label}</span>
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </>
              )}
              {collapsed && item.badge && (
                <span className="nav-badge-dot" />
              )}
            </button>
          ))}
        </nav>

        {/* ── Footer user card ── */}
        <div className="sidebar-footer">
          <div
            className={`nav-item ${collapsed ? "nav-item-collapsed" : ""}`}
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: "var(--radius-md)",
              cursor: "default",
            }}
          >
            <div
              style={{
                width: 34, height: 34, borderRadius: "50%",
                background: "var(--gold-primary)", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 800, fontSize: 14, color: "var(--text-dark)",
              }}
            >
              {user.name[0]}
            </div>
            {!collapsed && (
              <div style={{ overflow: "hidden" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {user.name}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
                  {user.role === "admin"
                    ? "Admin"
                    : user.role === "super_admin"
                      ? "Super Admin"
                      : user.role === "asha"
                        ? `ASHA Worker • ${formatLocationsLabel(user)}`
                        : "Patient"}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────
function TopBar({ user, pageTitle, onLogout, onMenuToggle, onNav }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="sidebar-toggle" onClick={onMenuToggle}>☰</button>
        <div>
          <div className="topbar-title">{pageTitle}</div>
          <div className="topbar-breadcrumb">HealthGPT › {pageTitle}</div>
        </div>
      </div>
      <div className="topbar-right">
        <div className="notif-btn">
          🔔
          <span className="notif-dot" />
        </div>
        {user.role === "asha" && (
          <span className="badge badge-blue">📍 {formatLocationsLabel(user)}</span>
        )}
        {(user.role === "admin" || user.role === "super_admin") ? (
          <button
            type="button"
            className="welcome-text welcome-link"
            onClick={() => onNav && onNav("manage-admin")}
            title="Manage admin profile & security"
          >
            👤 {user.email}
          </button>
        ) : (
          <div className="welcome-text">{user.email}</div>
        )}
        <button className="btn-signout" onClick={onLogout}>Sign Out</button>
      </div>
    </header>
  );
}

// ─── Manage Admin Profile (name, password, security question, account safety) ─
function ManageAdminProfile({ adminProfile, setAdminProfile, onBack, toast, onLogout, onNameSaved }) {
  const [name, setName] = useState(adminProfile.name);

  const [curPw, setCurPw]   = useState("");
  const [newPw, setNewPw]   = useState("");
  const [confPw, setConfPw] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [pwError, setPwError] = useState("");

  const [secQ, setSecQ] = useState(adminProfile.securityQuestion || SECURITY_QUESTIONS[0]);
  const [secA, setSecA] = useState("");
  const [secCurPw, setSecCurPw] = useState("");
  const [secError, setSecError] = useState("");

  const strength = newPw ? passwordStrength(newPw) : null;

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed) { toast("Name cannot be empty", "error"); return; }
    setAdminProfile((p) => ({ ...p, name: trimmed }));
    onNameSaved && onNameSaved(trimmed);
    toast("Profile updated", "success", "Display name changed successfully");
  };

  const submitPasswordChange = (e) => {
    e.preventDefault();
    setPwError("");
    if (curPw !== adminProfile.password) {
      setPwError("Current password is incorrect.");
      return;
    }
    if (newPw.length < 8) {
      setPwError("New password must be at least 8 characters long.");
      return;
    }
    if (!(/[a-z]/.test(newPw) && /[A-Z]/.test(newPw) && /\d/.test(newPw))) {
      setPwError("Password should include upper-case, lower-case letters and a number.");
      return;
    }
    if (newPw === curPw) {
      setPwError("New password must be different from your current password.");
      return;
    }
    if (newPw !== confPw) {
      setPwError("New password and confirmation do not match.");
      return;
    }
    setAdminProfile((p) => ({
      ...p,
      password: newPw,
      lastPasswordChange: new Date().toISOString(),
      failedAttempts: 0,
      lockUntil: null,
    }));
    setCurPw(""); setNewPw(""); setConfPw("");
    toast("Password changed", "success", "Use your new password the next time you sign in.");
  };

  const submitSecurityQuestion = (e) => {
    e.preventDefault();
    setSecError("");
    if (secCurPw !== adminProfile.password) {
      setSecError("Please confirm your current password to update the security question.");
      return;
    }
    if (!secA.trim() || secA.trim().length < 3) {
      setSecError("Security answer must be at least 3 characters.");
      return;
    }
    setAdminProfile((p) => ({ ...p, securityQuestion: secQ, securityAnswer: secA.trim() }));
    setSecCurPw(""); setSecA("");
    toast("Security question saved", "success", "This will be used to verify your identity if you ever lose access.");
  };

  const fmt = (iso) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  };

  return (
    <div className="page-body">
      <div className="card card-ai" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="card-title">👤 Manage Admin Profile</div>
          <button className="btn btn-outline-purple btn-sm" onClick={onBack}>← Back to Dashboard</button>
        </div>
        <div className="card-body">
          <div className="form-section">
            <div className="form-section-title">🪪 Basic Information</div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Display Name</label>
                <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Email (login id)</label>
                <input className="form-input" value={adminProfile.email} disabled
                  style={{ background: "#F3F4F6", cursor: "not-allowed", color: "#6B7280" }} />
                <span className="form-hint">Login email is fixed for this account and can't be changed here.</span>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-gold btn-sm" onClick={saveName}>Save Name</button>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">🛡️ Account Security Overview</div>
            <div className="form-grid">
              <div className="form-group">
                <span className="form-label">Last Login</span>
                <span style={{ fontSize: 14, color: "#374151", fontWeight: 600 }}>{fmt(adminProfile.lastLogin)}</span>
              </div>
              <div className="form-group">
                <span className="form-label">Last Password Change</span>
                <span style={{ fontSize: 14, color: "#374151", fontWeight: 600 }}>{fmt(adminProfile.lastPasswordChange)}</span>
              </div>
              <div className="form-group">
                <span className="form-label">Security Question</span>
                <span className="badge" style={{ background: adminProfile.securityQuestion ? "#D1FAE5" : "#FEE2E2", color: adminProfile.securityQuestion ? "#065F46" : "#991B1B" }}>
                  {adminProfile.securityQuestion ? "Configured" : "Not set"}
                </span>
              </div>
              <div className="form-group">
                <span className="form-label">Failed Login Attempts</span>
                <span style={{ fontSize: 14, color: "#374151", fontWeight: 600 }}>
                  {adminProfile.failedAttempts || 0} / {LOCKOUT_MAX_ATTEMPTS} {adminProfile.lockUntil && adminProfile.lockUntil > Date.now() ? " — 🔒 Currently locked" : ""}
                </span>
              </div>
            </div>
            <div className="form-hint" style={{ marginTop: 10 }}>
              For your protection, the account is automatically locked for 15 minutes after {LOCKOUT_MAX_ATTEMPTS} consecutive
              failed login attempts. This slows down brute-force and password-guessing attacks.
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">🔑 Change Password</div>
            <form onSubmit={submitPasswordChange}>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">Current Password</label>
                  <div className="input-wrapper">
                    <input
                      className="form-input has-action"
                      type={showCur ? "text" : "password"}
                      value={curPw}
                      onChange={(e) => setCurPw(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                    <button type="button" className="input-action" onClick={() => setShowCur((p) => !p)}>
                      {showCur ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">New Password</label>
                  <div className="input-wrapper">
                    <input
                      className="form-input has-action"
                      type={showNew ? "text" : "password"}
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      autoComplete="new-password"
                      required
                    />
                    <button type="button" className="input-action" onClick={() => setShowNew((p) => !p)}>
                      {showNew ? "🙈" : "👁️"}
                    </button>
                  </div>
                  {strength && (
                    <div className="pw-meter">
                      <div className={`pw-meter-fill ${strength.cls}`} style={{ width: `${strength.pct}%` }} />
                      <span className={`pw-meter-label ${strength.cls}`}>{strength.label}</span>
                    </div>
                  )}
                  <span className="form-hint">At least 8 characters, mixing upper/lower-case letters and a number. Add a symbol for extra strength.</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Confirm New Password</label>
                  <input
                    className="form-input"
                    type={showNew ? "text" : "password"}
                    value={confPw}
                    onChange={(e) => setConfPw(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>
              {pwError && <div className="form-error" style={{ marginTop: 10 }}>{pwError}</div>}
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-gold btn-sm" type="submit">Update Password</button>
              </div>
            </form>
          </div>

          <div className="form-section">
            <div className="form-section-title">❓ Security Question (used for account recovery)</div>
            <form onSubmit={submitSecurityQuestion}>
              <div className="form-grid">
                <div className="form-group full">
                  <label className="form-label">Choose a Question</label>
                  <select className="form-select" value={secQ} onChange={(e) => setSecQ(e.target.value)}>
                    {SECURITY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Your Answer</label>
                  <input className="form-input" value={secA} onChange={(e) => setSecA(e.target.value)} placeholder="Answer (case-insensitive)" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Confirm Current Password</label>
                  <input className="form-input" type="password" value={secCurPw} onChange={(e) => setSecCurPw(e.target.value)} required autoComplete="current-password" />
                </div>
              </div>
              {secError && <div className="form-error" style={{ marginTop: 10 }}>{secError}</div>}
              <div className="form-hint" style={{ marginTop: 6 }}>
                We never display your saved answer back to you, and it is only used to verify your identity — never as a substitute login method.
              </div>
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-outline-purple btn-sm" type="submit">Save Security Question</button>
              </div>
            </form>
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <div className="form-section-title">🚪 Session</div>
            <div className="form-hint" style={{ marginBottom: 10 }}>
              If you suspect unauthorized access to this account, sign out immediately and change your password from a trusted device.
            </div>
            <button className="btn btn-danger btn-sm" onClick={onLogout}>Sign Out This Session</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Reminder ─────────────────────────────────────────────────────────────────
const REMINDER_STORAGE_KEY = "ashaplus_reminders_v1";

function loadReminders() {
  try {
    const raw = localStorage.getItem(REMINDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveReminders(list) {
  try {
    localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(list));
  } catch {}
}

function computeNextFire(r) {
  if (r.mode === "once") {
    if (!r.date || !r.time) return null;
    const t = new Date(`${r.date}T${r.time}:00`).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const intervalMs = ((Number(r.everyHrs) || 0) * 60 + (Number(r.everyMin) || 0)) * 60 * 1000;
  if (!intervalMs) return null;
  const base = r.lastFired || r.createdAt || Date.now();
  return base + intervalMs;
}

function formatWhen(r) {
  if (r.mode === "once") {
    if (!r.date) return "No date set";
    const d = new Date(`${r.date}T${r.time || "00:00"}:00`);
    return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  const h = Number(r.everyHrs) || 0;
  const m = Number(r.everyMin) || 0;
  const parts = [];
  if (h) parts.push(`${h} hr${h !== 1 ? "s" : ""}`);
  if (m) parts.push(`${m} min`);
  return `Every ${parts.join(" ") || "—"}`;
}

function Reminder() {
  const [reminders, setReminders] = useState(loadReminders);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  const emptyForm = { text: "", mode: "once", date: "", time: "", everyHrs: "", everyMin: "" };
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => saveReminders(reminders), [reminders]);

  const requestPermission = () => {
    if (typeof Notification === "undefined") return;
    Notification.requestPermission().then(setNotifPermission);
  };

  const fireNotification = (r) => {
    const title = "⏰ ASHA+ Reminder";
    const body = r.text;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
          navigator.serviceWorker.getRegistration().then((reg) => {
            if (reg) {
              reg.showNotification(title, { body, icon: "/favicon.ico", tag: `reminder-${r.id}`, requireInteraction: true });
            } else {
              new Notification(title, { body, icon: "/favicon.ico" });
            }
          }).catch(() => new Notification(title, { body, icon: "/favicon.ico" }));
        } else {
          new Notification(title, { body, icon: "/favicon.ico" });
        }
      } catch {
        window.alert(`${title}\n${body}`);
      }
    } else {
      window.alert(`${title}\n${body}`);
    }
  };

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setReminders((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (r.done || r.paused) return r;
          const fireAt = computeNextFire(r);
          if (fireAt !== null && fireAt <= now) {
            fireNotification(r);
            changed = true;
            if (r.mode === "once") {
              return { ...r, done: true, lastFired: now };
            }
            return { ...r, lastFired: now };
          }
          return r;
        });
        return changed ? next : prev;
      });
    };
    const id = setInterval(tick, 15000);
    tick();
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const submitForm = (e) => {
    e.preventDefault();
    if (!form.text.trim()) return;
    if (form.mode === "once" && (!form.date || !form.time)) {
      window.alert("Please pick both a date and a time for a one-time reminder.");
      return;
    }
    if (form.mode === "interval" && !(Number(form.everyHrs) || Number(form.everyMin))) {
      window.alert("Please set hours and/or minutes for a recurring reminder.");
      return;
    }

    if (editingId) {
      setReminders((prev) =>
        prev.map((r) =>
          r.id === editingId ? { ...r, ...form, done: false, lastFired: null } : r
        )
      );
    } else {
      setReminders((prev) => [
        { id: Date.now(), ...form, createdAt: Date.now(), lastFired: null, done: false, paused: false },
        ...prev,
      ]);
    }
    resetForm();
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setForm({
      text: r.text, mode: r.mode, date: r.date || "", time: r.time || "",
      everyHrs: r.everyHrs || "", everyMin: r.everyMin || "",
    });
  };

  const removeReminder = (id) => {
    if (editingId === id) resetForm();
    setReminders((prev) => prev.filter((r) => r.id !== id));
  };

  const togglePause = (id) =>
    setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, paused: !r.paused } : r)));

  const snooze = (id, minutes) =>
    setReminders((prev) =>
      prev.map((r) =>
        r.id === id
          ? r.mode === "once"
            ? {
                ...r,
                date: new Date(Date.now() + minutes * 60000).toISOString().slice(0, 10),
                time: new Date(Date.now() + minutes * 60000).toTimeString().slice(0, 5),
                done: false,
              }
            : {
                ...r,
                lastFired:
                  Date.now() -
                  (((Number(r.everyHrs) || 0) * 60 + (Number(r.everyMin) || 0)) * 60000) +
                  minutes * 60000,
              }
          : r
      )
    );

  const markDone = (id) =>
    setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, done: true } : r)));

  const active = reminders.filter((r) => !r.done);
  const done = reminders.filter((r) => r.done);

  return (
    <div className="page-body">
      {notifPermission !== "granted" && notifPermission !== "unsupported" && (
        <div className="card card-ai" style={{ marginBottom: 16, borderColor: "#F59E0B" }}>
          <div className="card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div style={{ fontSize: 14 }}>
              🔔 Turn on notifications so reminders can alert you here — on this laptop or on your phone's
              browser — even if the ASHA+ tab is in the background. (Your browser must have the tab open;
              fully closed-app push isn't wired up yet.)
            </div>
            <button className="btn btn-gold btn-sm" onClick={requestPermission}>Enable Notifications</button>
          </div>
        </div>
      )}

      <div className="card card-ai">
        <div className="card-header">
          <div className="card-title">⏰ Reminders</div>
          <span className="badge badge-purple">{active.length} active</span>
        </div>
        <div className="card-body">
          <form onSubmit={submitForm} style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
            <input
              className="login-input"
              type="text"
              placeholder="What do you want to be reminded about? (e.g. Take BP medicine)"
              value={form.text}
              onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
            />

            <div className="btn-tabs btn-tabs-compact" style={{ width: "fit-content" }}>
              <button
                type="button"
                className={`btn-tab ${form.mode === "once" ? "active" : ""}`}
                onClick={() => setForm((f) => ({ ...f, mode: "once" }))}
              >
                📅 One-time (date &amp; time)
              </button>
              <button
                type="button"
                className={`btn-tab ${form.mode === "interval" ? "active" : ""}`}
                onClick={() => setForm((f) => ({ ...f, mode: "interval" }))}
              >
                🔁 Repeat every N hrs/min
              </button>
            </div>

            {form.mode === "once" ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input
                  className="login-input"
                  style={{ flex: "1 1 180px" }}
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                />
                <input
                  className="login-input"
                  style={{ flex: "1 1 140px" }}
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ fontSize: 13, color: "#6B7280", display: "flex", alignItems: "center", gap: 6 }}>
                  Every
                  <input
                    className="login-input"
                    style={{ width: 90 }}
                    type="number"
                    min="0"
                    placeholder="0"
                    value={form.everyHrs}
                    onChange={(e) => setForm((f) => ({ ...f, everyHrs: e.target.value }))}
                  />
                  hrs
                </label>
                <label style={{ fontSize: 13, color: "#6B7280", display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    className="login-input"
                    style={{ width: 90 }}
                    type="number"
                    min="0"
                    max="59"
                    placeholder="0"
                    value={form.everyMin}
                    onChange={(e) => setForm((f) => ({ ...f, everyMin: e.target.value }))}
                  />
                  min
                </label>
                <span style={{ fontSize: 12, color: "#6B7280" }}>e.g. every 8 hrs for a pill schedule</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button type="submit" className="btn btn-outline-purple">
                {editingId ? "💾 Save Changes" : "➕ Add Reminder"}
              </button>
              {editingId && (
                <button type="button" className="btn btn-ghost" onClick={resetForm}>Cancel</button>
              )}
            </div>
          </form>

          {active.length === 0 ? (
            <div style={{ color: "#6B7280", fontSize: 14 }}>No active reminders. Add one above.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: done.length ? 24 : 0 }}>
              {active.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                    padding: "12px 16px", border: "1px solid var(--border, #e5e4e7)", borderRadius: 10,
                    opacity: r.paused ? 0.55 : 1, flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {r.text} {r.paused && <span className="badge badge-red" style={{ marginLeft: 6 }}>Paused</span>}
                      {r.mode === "interval" && <span className="badge badge-blue" style={{ marginLeft: 6 }}>Recurring</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>{formatWhen(r)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="btn btn-soft btn-sm" onClick={() => snooze(r.id, 10)}>😴 Snooze 10m</button>
                    <button className="btn btn-soft btn-sm" onClick={() => togglePause(r.id)}>
                      {r.paused ? "▶️ Resume" : "⏸ Pause"}
                    </button>
                    <button className="btn btn-outline-purple btn-sm" onClick={() => startEdit(r)}>✏️ Edit</button>
                    {r.mode === "once" && (
                      <button className="btn btn-outline-purple btn-sm" onClick={() => markDone(r.id)}>✔️ Done</button>
                    )}
                    <button className="btn btn-danger btn-sm" onClick={() => removeReminder(r.id)}>🗑 Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {done.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#6B7280", marginBottom: 10 }}>
                Completed ({done.length})
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {done.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 14px", border: "1px solid var(--border, #e5e4e7)", borderRadius: 8,
                      opacity: 0.6, textDecoration: "line-through",
                    }}
                  >
                    <div>{r.text}</div>
                    <button
                      className="btn btn-soft btn-sm"
                      style={{ textDecoration: "none" }}
                      onClick={() => removeReminder(r.id)}
                    >
                      🗑 Delete
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Calendar Note ────────────────────────────────────────────────────────────
const CALENDAR_NOTES_KEY = "ashaplus_calendar_notes_v1";
const CAL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const CAL_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function loadCalendarNotes() {
  try {
    const raw = localStorage.getItem(CALENDAR_NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCalendarNotes(map) {
  try {
    localStorage.setItem(CALENDAR_NOTES_KEY, JSON.stringify(map));
  } catch {}
}

// Local yyyy-mm-dd key (avoids UTC off-by-one from toISOString)
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function CalendarNote() {
  const today = new Date();
  const [notesByDate, setNotesByDate] = useState(loadCalendarNotes);
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedKey, setSelectedKey] = useState(dateKey(today));
  const [draft, setDraft] = useState("");
  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState("");

  useEffect(() => saveCalendarNotes(notesByDate), [notesByDate]);

  const todayKey = dateKey(today);
  const selectedNotes = notesByDate[selectedKey] || [];

  const goToMonth = (delta) => {
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  };

  const selectDate = (d) => {
    setSelectedKey(dateKey(d));
    setEditingIdx(null);
    setDraft("");
  };

  const addNote = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setNotesByDate((prev) => ({
      ...prev,
      [selectedKey]: [...(prev[selectedKey] || []), text],
    }));
    setDraft("");
  };

  const startEditNote = (idx) => {
    setEditingIdx(idx);
    setEditDraft(selectedNotes[idx]);
  };

  const saveEditNote = (idx) => {
    const text = editDraft.trim();
    if (!text) return;
    setNotesByDate((prev) => {
      const list = [...(prev[selectedKey] || [])];
      list[idx] = text;
      return { ...prev, [selectedKey]: list };
    });
    setEditingIdx(null);
    setEditDraft("");
  };

  const deleteNote = (idx) => {
    setNotesByDate((prev) => {
      const list = (prev[selectedKey] || []).filter((_, i) => i !== idx);
      const next = { ...prev };
      if (list.length) next[selectedKey] = list;
      else delete next[selectedKey];
      return next;
    });
    if (editingIdx === idx) { setEditingIdx(null); setEditDraft(""); }
  };

  // ── Build calendar grid cells for the visible month ──
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDayIdx = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDayIdx; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const selectedLabel = (() => {
    const [y, m, d] = selectedKey.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  })();

  return (
    <div className="page-body">
      <div className="card card-ai" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <div className="card-title">🗓️ Calendar Note</div>
          <span className="badge badge-purple">{Object.keys(notesByDate).length} dates with notes</span>
        </div>
        <div className="card-body">
          <div className="calnote-layout">
            {/* ── Calendar grid ── */}
            <div className="calnote-calendar">
              <div className="calnote-cal-header">
                <button type="button" className="btn btn-soft btn-sm" onClick={() => goToMonth(-1)}>‹</button>
                <div className="calnote-cal-title">{CAL_MONTH_NAMES[month]} {year}</div>
                <button type="button" className="btn btn-soft btn-sm" onClick={() => goToMonth(1)}>›</button>
              </div>

              <div className="calnote-grid calnote-weekdays">
                {CAL_WEEKDAYS.map((w) => (
                  <div key={w} className="calnote-weekday">{w}</div>
                ))}
              </div>

              <div className="calnote-grid">
                {cells.map((d, i) => {
                  if (!d) return <div key={`blank-${i}`} className="calnote-cell calnote-cell-empty" />;
                  const k = dateKey(d);
                  const hasNotes = !!notesByDate[k]?.length;
                  const isToday = k === todayKey;
                  const isSelected = k === selectedKey;
                  return (
                    <button
                      type="button"
                      key={k}
                      className={`calnote-cell ${isToday ? "calnote-cell-today" : ""} ${isSelected ? "calnote-cell-selected" : ""} ${hasNotes ? "calnote-cell-has-notes" : ""}`}
                      onClick={() => selectDate(d)}
                      title={hasNotes ? `${notesByDate[k].length} note(s)` : ""}
                    >
                      <span>{d.getDate()}</span>
                      {hasNotes && <span className="calnote-dot" />}
                    </button>
                  );
                })}
              </div>

              <div className="calnote-legend">
                <span><i className="calnote-legend-dot" /> Has notes</span>
                <span><i className="calnote-legend-today" /> Today</span>
                <span><i className="calnote-legend-selected" /> Selected</span>
              </div>
            </div>

            {/* ── Notes panel for selected date ── */}
            <div className="calnote-panel">
              <div className="calnote-panel-title">{selectedLabel}</div>

              <form onSubmit={addNote} className="calnote-add-form">
                <input
                  className="login-input"
                  type="text"
                  placeholder="Add a note point for this date…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" className="btn btn-outline-purple btn-sm">➕ Add</button>
              </form>

              {selectedNotes.length === 0 ? (
                <div style={{ color: "#6B7280", fontSize: 14, marginTop: 12 }}>
                  No notes for this date yet.
                </div>
              ) : (
                <ul className="calnote-list">
                  {selectedNotes.map((note, idx) => (
                    <li key={idx} className="calnote-item">
                      {editingIdx === idx ? (
                        <>
                          <input
                            className="login-input"
                            style={{ flex: 1 }}
                            type="text"
                            value={editDraft}
                            autoFocus
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && saveEditNote(idx)}
                          />
                          <div className="calnote-item-actions">
                            <button className="btn btn-outline-purple btn-sm" onClick={() => saveEditNote(idx)}>💾 Save</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditingIdx(null)}>Cancel</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="calnote-item-text">{note}</span>
                          <div className="calnote-item-actions">
                            <button className="btn btn-soft btn-sm" onClick={() => startEditNote(idx)}>✏️ Edit</button>
                            <button className="btn btn-danger btn-sm" onClick={() => deleteNote(idx)}>🗑</button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Patient Dashboard ────────────────────────────────────────────────────────
function PatientDashboard({ user }) {
  const [patient, setPatient] = useState(null);

  // Look up this patient's own record in Firestore by matching their login email.
  useEffect(() => {
    if (!user?.email) return;
    const q = query(collection(db, "patients"), where("email", "==", user.email));
    return onSnapshot(q, (snap) => {
      if (!snap.empty) setPatient({ ...snap.docs[0].data(), id: snap.docs[0].id });
    });
  }, [user]);

  if (!patient) {
    return (
      <div className="page-body">
        <div className="card card-ai">
          <div className="card-body">Loading your profile…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-body">
      {/* Profile Header */}
      <div className="profile-header mb-6">
        <div className="profile-avatar">{patient.name[0]}</div>
        <div>
          <div className="profile-name">{patient.name}</div>
          <div className="profile-role">Patient ID: {patient.id}</div>
          <div className="profile-meta">
            <div className="profile-meta-item">🩸 {patient.blood}</div>
            <div className="profile-meta-item">👤 {patient.gender}, {patient.age} yrs</div>
            <div className="profile-meta-item">📍 {patient.village}</div>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card gold">
          <div className="stat-icon">🩸</div>
          <div className="stat-label">Blood Group</div>
          <div className="stat-value" style={{ fontSize: 24 }}>{patient.blood}</div>
        </div>
        <div className="stat-card blue">
          <div className="stat-icon">⚖️</div>
          <div className="stat-label">BMI Status</div>
          <div className="stat-value" style={{ fontSize: 20 }}>Normal</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon">✅</div>
          <div className="stat-label">Last Checkup</div>
          <div className="stat-value" style={{ fontSize: 18 }}>Jan 2025</div>
        </div>
        <div className="stat-card pink">
          <div className="stat-icon">💊</div>
          <div className="stat-label">Active Conditions</div>
          <div className="stat-value">{patient.diseases === "None" ? 0 : 1}</div>
        </div>
      </div>

      {/* Health Info */}
      <div className="card card-ai">
        <div className="card-header">
          <div className="card-title-hi">स्वास्थ्य जानकारी</div>
          <span className="badge badge-green">✅ Up to Date</span>
        </div>
        <div className="card-body">
          <div className="form-grid">
            {[
              ["Full Name",   patient.name],
              ["Age",         `${patient.age} years`],
              ["Gender",      patient.gender],
              ["Blood Group", patient.blood],
              ["Mobile",      patient.mobile],
              ["Village",     patient.village],
              ["State",       patient.state],
              ["Condition",   patient.diseases],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="form-label">{k}</div>
                <div style={{ fontWeight: 600, color: "var(--text-dark)", marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AI Chatbot — structured message renderer ─────────────────────────────────
function formatBotMessage(text) {
  if (!text) return null;

  // Plain greeting or emergency message — no special structure detected
  const hasStructure =
    text.includes("## ") || text.includes("### ") || text.includes("| ");
  if (!hasStructure) {
    return (
      <span style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
        {text}
      </span>
    );
  }

  const lines = text.split("\n");
  const elements = [];
  let i = 0;

  // ── helpers ────────────────────────────────────────────────────────────────
  const isTableRow  = (l) => l.trim().startsWith("|");
  const isSeparator = (l) => /^\|[-| :]+\|$/.test(l.trim());

  while (i < lines.length) {
    const raw  = lines[i];
    const line = raw.trim();

    // Skip blank lines
    if (!line) { i++; continue; }

    // ── ## Main heading ──────────────────────────────────────────────────────
    if (line.startsWith("## ")) {
      elements.push(
        <div
          key={`h2-${i}`}
          style={{
            fontWeight: 800,
            fontSize: 15.5,
            color: "var(--purple-primary)",
            marginBottom: 10,
            marginTop: 4,
            letterSpacing: 0.1,
            lineHeight: 1.4,
          }}
        >
          {line.replace(/^##\s+/, "")}
        </div>
      );
      i++; continue;
    }

    // ── ### Subheading ───────────────────────────────────────────────────────
    if (line.startsWith("### ")) {
      const sub = line.replace(/^###\s+/, "");
      const isDoctor   = sub.includes("🚨");
      const isMedicine = sub.includes("💊");
      const isKey      = sub.includes("✅");
      const color = isDoctor ? "#DC2626" : isMedicine ? "#7C3AED" : "#059669";
      const bg    = isDoctor ? "#FEF2F2" : isMedicine ? "#F5F3FF" : "#F0FDF4";
      const border = isDoctor ? "#FECACA" : isMedicine ? "#DDD6FE" : "#BBF7D0";
      elements.push(
        <div
          key={`h3-${i}`}
          style={{
            fontWeight: 700,
            fontSize: 13.5,
            color,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 8,
            padding: "6px 12px",
            marginTop: 12,
            marginBottom: 6,
          }}
        >
          {sub}
        </div>
      );
      i++; continue;
    }

    // ── Markdown table (collect all rows) ────────────────────────────────────
    if (isTableRow(line)) {
      const tableLines = [];
      while (i < lines.length && (isTableRow(lines[i]) || isSeparator(lines[i]))) {
        tableLines.push(lines[i].trim());
        i++;
      }
      // parse rows — split by | and strip empty edge cells
      const rows = tableLines
        .filter((l) => !isSeparator(l))
        .map((l) =>
          l
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim())
        );
      if (rows.length > 0) {
        const [headerRow, ...bodyRows] = rows;
        elements.push(
          <div
            key={`tbl-${i}`}
            style={{ overflowX: "auto", marginTop: 6, marginBottom: 6 }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr>
                  {headerRow.map((h, ci) => (
                    <th
                      key={ci}
                      style={{
                        background: "#7C3AED",
                        color: "#fff",
                        padding: "7px 10px",
                        textAlign: "left",
                        fontWeight: 600,
                        fontSize: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr
                    key={ri}
                    style={{ background: ri % 2 === 0 ? "#F5F3FF" : "#fff" }}
                  >
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        style={{
                          padding: "6px 10px",
                          borderBottom: "1px solid #EDE9FE",
                          fontSize: 12.5,
                          lineHeight: 1.5,
                        }}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    // ── Numbered list item  1. … ─────────────────────────────────────────────
    // NOTE: explicit "N." text markers are used here instead of a real
    // <ol>/<li> (which would rely on the browser's automatic CSS counter /
    // ::marker to draw the numbers). html2canvas — used by the "Download PDF"
    // button below — does not render ::marker/list-style counters, so numbered
    // steps rendered as a real <ol> would come out in the PDF with the numbers
    // missing or misaligned even though they display fine in the on-screen
    // chat. Writing the "1.", "2." … as plain text content instead means the
    // exact same markup renders identically in both the chat window and the
    // captured PDF.
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <div key={`ol-${i}`} style={{ margin: "4px 0 8px 0" }}>
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 6,
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "#1F2937",
              }}
            >
              <span style={{ fontWeight: 700, flexShrink: 0 }}>{idx + 1}.</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      );
      continue;
    }

    // ── Bullet list item  - … ────────────────────────────────────────────────
    // Same html2canvas ::marker limitation as the numbered list above — use
    // an explicit "•" text character instead of real <ul>/<li> bullets.
    if (line.startsWith("- ") || line.startsWith("• ")) {
      const items = [];
      while (
        i < lines.length &&
        (lines[i].trim().startsWith("- ") || lines[i].trim().startsWith("• "))
      ) {
        items.push(lines[i].trim().replace(/^[-•]\s+/, ""));
        i++;
      }
      elements.push(
        <div key={`ul-${i}`} style={{ margin: "4px 0 8px 0" }}>
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 5,
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "#1F2937",
              }}
            >
              <span style={{ flexShrink: 0 }}>•</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      );
      continue;
    }

    // ── ⚠️ Disclaimer / warning line ─────────────────────────────────────────
    if (line.startsWith("⚠️")) {
      elements.push(
        <div
          key={`warn-${i}`}
          style={{
            background: "#FEF3C7",
            border: "1px solid #FCD34D",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12.5,
            color: "#92400E",
            fontWeight: 600,
            marginTop: 6,
            marginBottom: 4,
            lineHeight: 1.5,
          }}
        >
          {line}
        </div>
      );
      i++; continue;
    }

    // ── Horizontal rule --- ───────────────────────────────────────────────────
    if (/^-{3,}$/.test(line)) {
      elements.push(
        <hr
          key={`hr-${i}`}
          style={{ border: "none", borderTop: "1px solid #EDE9FE", margin: "10px 0" }}
        />
      );
      i++; continue;
    }

    // ── "Do not self-medicate." closing line ─────────────────────────────────
    if (
      line.toLowerCase().includes("do not self-medicate") ||
      line.toLowerCase().includes("स्वयं दवाई न लें")
    ) {
      elements.push(
        <div
          key={`close-${i}`}
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "#DC2626",
            marginTop: 6,
            fontStyle: "italic",
          }}
        >
          {line}
        </div>
      );
      i++; continue;
    }

    // ── "See a doctor immediately if…" label ─────────────────────────────────
    if (
      line.toLowerCase().includes("see a doctor") ||
      line.toLowerCase().includes("तुरंत डॉक्टर")
    ) {
      elements.push(
        <div
          key={`seeDoc-${i}`}
          style={{ fontSize: 13, fontWeight: 600, color: "#DC2626", marginTop: 4 }}
        >
          {line}
        </div>
      );
      i++; continue;
    }

    // ── Fallback: plain paragraph ─────────────────────────────────────────────
    elements.push(
      <p
        key={`p-${i}`}
        style={{ margin: "3px 0", fontSize: 13.5, lineHeight: 1.6, color: "#374151" }}
      >
        {line}
      </p>
    );
    i++;
  }

  return elements.length ? <>{elements}</> : <span>{text}</span>;
}

// ─── AI Chatbot ───────────────────────────────────────────────────────────────
const BOT_GREET =
  "नमस्ते! 🙏 I'm HealthGPT, your health assistant. Ask me about symptoms, medicines, or general health tips!";

// Builds a printable PDF from the chat history — each patient question
// paired with HealthGPT's full instructions/medicine/caution response.
//
// IMPORTANT: this renders a hidden DOM node (using the same formatBotMessage
// renderer as the on-screen chat) and converts THAT to a PDF via html2pdf.js
// (html2canvas + jsPDF under the hood). We deliberately do NOT draw text
// directly with jsPDF, because jsPDF has no text-shaping engine — it places
// Devanagari glyphs one-by-one in raw Unicode order, so conjuncts (क्ष, त्र)
// and vowel-sign reordering (कि, कु) never form correctly no matter which
// font is embedded. Going through the browser's own rendering (which already
// shapes Hindi correctly, as seen in the chat window) and capturing that as
// an image guarantees the PDF matches what's on screen exactly.
function downloadChatAsPdf(messages, containerEl) {
  const qa = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].from === "user") {
      const answer = messages[i + 1]?.from === "bot" ? messages[i + 1].text : null;
      qa.push({ question: messages[i].text, answer });
    }
  }
  if (qa.length === 0 || !containerEl) return Promise.resolve();

  return html2pdf()
    .set({
      margin: [32, 28, 32, 28],
      filename: `HealthGPT-Health-Advice-${Date.now()}.pdf`,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        scrollX: 0,
        scrollY: 0,
        // The printable div is deliberately pushed off-screen with
        // "left: -9999px" so users never see it. But html2canvas renders
        // a clone of the page inside an off-screen iframe that's only as
        // wide as the current window — anything sitting at x = -9999 falls
        // completely outside that render area, so the "screenshot" it takes
        // is empty and html2pdf.js happily turns that blank image into a PDF.
        // Fix: in the clone (and ONLY in the clone — the real on-screen DOM
        // is untouched) snap the element back to (0, 0) so it's inside the
        // rendered area right before the capture happens.
        onclone: (clonedDoc) => {
          const el = clonedDoc.getElementById("asha-pdf-content");
          if (el) {
            el.style.left = "0px";
            el.style.top = "0px";
          }
        },
      },
      jsPDF: { unit: "pt", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["avoid-all", "css", "legacy"] },
    })
    .from(containerEl)
    .save();
}

function ChatBot() {
  const [messages, setMessages] = useState([
    { from: "bot", text: BOT_GREET },
  ]);
  const [input, setInput]         = useState("");
  const [loading, setLoad]        = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceLang, setVoiceLang] = useState("en-IN"); // "en-IN" | "hi-IN" — must be picked BEFORE starting the mic
  const [recentQuestions, setRecentQuestions] = useState([]);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const recognitionRef = useRef(null);
  const pdfContentRef  = useRef(null); // hidden DOM node captured for the downloadable PDF

  // ── Live listener: last 5 questions from Firestore cache ──────────────────
  // Strategy: try ordered (newest first). If that fails due to a missing Firestore
  // index or a rules issue, fall back to unordered so something always shows.
  useEffect(() => {
    let unsub = () => {};

    const attachUnordered = () => {
      const q = query(collection(db, "cached_responses"), limit(5));
      unsub = onSnapshot(
        q,
        (snap) => {
          const qs = snap.docs
            .map((d) => d.data().originalPrompt)
            .filter(Boolean);
          setRecentQuestions(qs);
        },
        (err) => {
          // If even the unordered query fails it is a rules problem.
          // Log it so the developer can see the real error in the console.
          console.error("[HealthGPT] cached_responses read failed:", err.code, err.message);
        }
      );
    };

    const attachOrdered = () => {
      const q = query(
        collection(db, "cached_responses"),
        orderBy("createdAt", "desc"),
        limit(5)
      );
      unsub = onSnapshot(
        q,
        (snap) => {
          const qs = snap.docs
            .map((d) => d.data().originalPrompt)
            .filter(Boolean);
          setRecentQuestions(qs);
        },
        (err) => {
          // "failed-precondition" = missing Firestore index for orderBy.
          // "permission-denied"   = Firestore rules not yet deployed.
          // Either way, fall back to unordered so recent questions still appear.
          console.warn(
            "[HealthGPT] Ordered cache query failed (" + err.code + ") — falling back to unordered."
          );
          attachUnordered();
        }
      );
    };

    attachOrdered();
    return () => unsub();
  }, []);

  // Rebuilt every time voiceLang changes, so the mic always listens in
  // whichever language the user picked BEFORE tapping the mic — no more
  // mixed-up Hindi/English recognition from a fixed "en-IN" setting.
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setVoiceSupported(false); return; }
    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = voiceLang;
    rec.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join("");
      setInput(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.stop(); } catch {} };
  }, [voiceLang]);

  const toggleVoice = () => {
    if (!recognitionRef.current) return;
    if (listening) {
      recognitionRef.current.stop();
      setListening(false);
    } else {
      setInput("");
      try {
        recognitionRef.current.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  };

  const sendMsg = async () => {
    if (!input.trim()) return;
    const userMsg = { from: "user", text: input };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoad(true);

    try {
      const { response } = await askHealthAssistant(input);
      setMessages((m) => [...m, { from: "bot", text: response }]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { from: "bot", text: `⚠️ ${err.message || "Unable to connect to AI. Please try again."}` },
      ]);
    } finally {
      setLoad(false);
    }
  };

  return (
    <div className="page-body">
      {/* Hidden printable version of the chat, captured by html2pdf.js when
          "Download PDF" is clicked, using the SAME formatBotMessage renderer
          as the visible chat so Hindi/Devanagari text is shaped correctly.

          IMPORTANT: html2pdf.js clones this element into its OWN internal
          hidden overlay (it manages positioning entirely itself). It must
          NOT already have position/left set on it — a clone that inherits
          "position: fixed; left: -9999px" fights html2pdf.js's own overlay
          positioning and gets rendered completely outside any capturable
          area, producing a blank PDF (exactly what was happening). So the
          actual print div below is left in normal, unpositioned flow, and
          is hidden from users purely via this zero-size, overflow:hidden
          OUTER wrapper — which is never part of the clone html2pdf.js
          makes, since cloneNode only copies the source element downward,
          not its ancestors. Rendered through a portal into document.body
          so no dashboard ancestor (overflow/transform) can clip it either. */}
      {createPortal(
        <div style={{ position: "fixed", top: 0, left: 0, width: 0, height: 0, overflow: "hidden" }}>
        <div
          id="asha-pdf-content"
          ref={pdfContentRef}
          style={{
            width: 650, background: "#ffffff", color: "#111827",
            padding: 28, fontFamily: "'Noto Sans', Arial, sans-serif",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>
            HealthGPT — Health Advice Summary
          </div>
          <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 18 }}>
            Generated on {new Date().toLocaleString()}
          </div>
          {(() => {
            const qa = [];
            for (let i = 0; i < messages.length; i++) {
              if (messages[i].from === "user") {
                const answer = messages[i + 1]?.from === "bot" ? messages[i + 1].text : null;
                qa.push({ question: messages[i].text, answer });
              }
            }
            return qa.map(({ question, answer }, idx) => (
              <div key={idx} style={{ marginBottom: 20, pageBreakInside: "avoid" }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8, lineHeight: 1.5 }}>
                  Q{idx + 1}. {question}
                </div>
                <div style={{ fontSize: 13 }}>
                  {answer ? formatBotMessage(answer) : "(No response received)"}
                </div>
              </div>
            ));
          })()}
          <div style={{ fontSize: 10, color: "#9CA3AF", fontStyle: "italic", marginTop: 10, lineHeight: 1.5 }}>
            This document is for reference only and does not replace professional medical advice.
            Always consult a qualified doctor before taking any medicine.
          </div>
        </div>
        </div>,
        document.body
      )}

      <div className="card card-ai">
        <div className="card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="card-title">
            🤖 AI Health Assistant
            <span className="ai-badge">✨ AI Powered</span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              setPdfGenerating(true);
              try {
                await downloadChatAsPdf(messages, pdfContentRef.current);
              } finally {
                setPdfGenerating(false);
              }
            }}
            disabled={!messages.some((m) => m.from === "user") || pdfGenerating}
            title="Download your questions and HealthGPT's advice as a PDF — handy to carry to the pharmacy"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              opacity: messages.some((m) => m.from === "user") ? 1 : 0.5,
            }}
          >
            {pdfGenerating ? "⏳ Preparing…" : "⬇️ Download PDF"}
          </button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="chatbot-container" style={{ height: 520, border: "none" }}>
            <div className="chatbot-header">
              <div className="chatbot-avatar">🩺</div>
              <div>
                <div className="chatbot-name">HealthGPT</div>
                <div className="chatbot-status">
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: "#86EFAC", display: "inline-block"
                  }} />
                  Online
                </div>
              </div>
            </div>

            <div className="chatbot-messages">
              {messages.map((m, i) => (
                <div key={i} className={`chat-msg ${m.from}`}>
                  {m.from === "bot" ? formatBotMessage(m.text) : m.text}
                </div>
              ))}
              {loading && (
                <div className="chat-msg bot" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="spinner" style={{
                    borderColor: "rgba(124,58,237,0.3)",
                    borderTopColor: "var(--purple-primary)", width: 14, height: 14
                  }} />
                  Thinking…
                </div>
              )}
            </div>

            {voiceSupported && (
              <div className="voice-lang-row" style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px", fontSize: 13,
              }}>
                <span style={{ opacity: 0.7 }}>🎙️ Voice language:</span>
                <button
                  type="button"
                  disabled={listening}
                  onClick={() => setVoiceLang("en-IN")}
                  className={`btn-tab ${voiceLang === "en-IN" ? "active" : ""}`}
                  title="Speak in English"
                >
                  English
                </button>
                <button
                  type="button"
                  disabled={listening}
                  onClick={() => setVoiceLang("hi-IN")}
                  className={`btn-tab ${voiceLang === "hi-IN" ? "active" : ""}`}
                  title="हिंदी में बोलें"
                >
                  हिंदी
                </button>
              </div>
            )}

            <div className="chatbot-input-area">
              <input
                className="chatbot-input"
                placeholder={listening ? "🎙️ Listening… speak now" : "Ask a health question in English or Hindi…"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMsg()}
              />
              {voiceSupported && (
                <button
                  type="button"
                  className={`voice-btn ${listening ? "listening" : ""}`}
                  onClick={toggleVoice}
                  title={listening ? "Stop listening" : `Ask by voice (${voiceLang === "hi-IN" ? "हिंदी" : "English"})`}
                >
                  {listening ? "⏹️" : "🎤"}
                </button>
              )}
              <button className="btn btn-gold btn-sm" onClick={sendMsg} disabled={loading}>
                Send ➤
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Suggested Questions (hardcoded) ─────────────────────────────── */}
      <div className="mt-4">
        <div className="form-label mb-2">💡 Suggested Questions</div>
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          {[
            "What are diabetes symptoms?",
            "BP control tips in Hindi",
            "Safe medicines in pregnancy",
            "बच्चों में बुखार का इलाज",
          ].map((q) => (
            <button
              key={q}
              className="btn btn-outline-purple btn-sm"
              onClick={() => setInput(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* ── Recent Questions (from Firestore cache) ──────────────────────── */}
      {recentQuestions.length > 0 && (
        <div className="mt-3">
          <div
            className="form-label mb-2"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            🕐 Recently Asked
            <span
              style={{
                fontSize: 11,
                background: "#EDE9FE",
                color: "#7C3AED",
                borderRadius: 20,
                padding: "1px 8px",
                fontWeight: 600,
              }}
            >
              {recentQuestions.length}
            </span>
          </div>
          <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
            {recentQuestions.map((q, idx) => (
              <button
                key={idx}
                onClick={() => setInput(q)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  background: "#F5F3FF",
                  border: "1px solid #DDD6FE",
                  borderRadius: 20,
                  padding: "5px 13px",
                  fontSize: 12.5,
                  color: "#5B21B6",
                  cursor: "pointer",
                  fontWeight: 500,
                  transition: "background 0.15s",
                  maxWidth: 260,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#EDE9FE")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#F5F3FF")}
                title={q}
              >
                <span style={{ fontSize: 13 }}>🔁</span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {q}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Health Records ───────────────────────────────────────────────────────────
function HealthRecords({ user, history, setHistory }) {
  const [patient, setPatient] = useState(null);

  // Look up this patient's own record in Firestore by matching their login email.
  useEffect(() => {
    if (!user?.email) return;
    const q = query(collection(db, "patients"), where("email", "==", user.email));
    return onSnapshot(q, (snap) => {
      if (!snap.empty) setPatient({ ...snap.docs[0].data(), id: snap.docs[0].id });
    });
  }, [user]);

  // Real-time visit history for this patient (admin/ASHA view loads this via
  // the activePatient effect in App; a patient viewing their own records needs
  // its own listener since there's no activePatient set for them).
  useEffect(() => {
    if (!patient) return;
    const q = query(
      collection(db, "patients", patient.id, "visits"),
      orderBy("date", "desc")
    );
    return onSnapshot(q, (snap) => {
      const visits = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      setHistory((prev) => ({ ...prev, [patient.id]: visits }));
    });
  }, [patient]);

  if (!patient) {
    return (
      <div className="page-body">
        <div className="card card-ai">
          <div className="card-body">Loading your records…</div>
        </div>
      </div>
    );
  }

  const records = history[patient.id] || [];

  return (
    <div className="page-body">
      <PatientHistoryCard
        patientId={patient.id}
        records={records}
        setHistory={setHistory}
        isAdmin={false}
      />
    </div>
  );
}

// ─── Govt Scheme Suggestions ───────────────────────────────────────────────────
// Eligibility + document data sourced from the official scheme analysis notes,
// kept bilingual (English / Hindi) so an ASHA worker can switch language
// instantly inside the modal while standing in front of a patient.
const GOVT_SCHEMES = [
  {
    id: "scheme-01",
    icon: "🏥", name: "Ayushman Bharat (PM-JAY)",
    desc: "Free hospitalisation cover up to ₹5 lakh per family per year at empanelled hospitals.",
    eligibilitySummary: "Families listed under SECC database / state extension criteria",
    officialLink: "https://pmjay.gov.in/",
    detailLink: "https://www.myscheme.gov.in/schemes/ab-pmjay",
    eligibility: {
      en: [
        "Rural Beneficiaries: Households living in single-room dwellings with kucha walls/roofs, households with no adult male member aged 16–59, disabled members with no able-bodied adult for support, and SC/ST or landless households deriving major income from manual casual labour.",
        "Urban Beneficiaries: Families belonging to 11 defined occupational categories, including ragpickers, domestic workers, street vendors, sanitation workers, and construction labourers.",
        "Automatic Inclusions: Destitute individuals, manual scavengers, legally released bonded labour, primitive tribal groups, and households without shelter.",
        "RSBY Coverage: Families enrolled under Rashtriya Swasthya Bima Yojana (RSBY) as of 28 February 2018 are automatically eligible.",
        "Senior Citizens: As of September 2024, all senior citizens aged 70 years and above are eligible for up to ₹5 lakh health coverage, regardless of socio-economic status.",
      ],
      hi: [
        "ग्रामीण लाभार्थी: एक कमरे के कच्चे मकान में रहने वाले परिवार, जिनमें 16 से 59 वर्ष के बीच कोई वयस्क पुरुष सदस्य न हो, दिव्यांग सदस्य जिनकी सहायता के लिए कोई सक्षम वयस्क न हो, तथा SC/ST या भूमिहीन परिवार जिनकी मुख्य आय शारीरिक श्रम से होती है।",
        "शहरी लाभार्थी: 11 निर्धारित व्यावसायिक श्रेणियों के परिवार, जैसे कबाड़ बीनने वाले, घरेलू कामगार, फेरीवाले, सफाई कर्मचारी और निर्माण मजदूर।",
        "स्वचालित समावेशन: निराश्रित व्यक्ति, सफाई कर्मी, कानूनी रूप से मुक्त बंधुआ मजदूर, आदिम जनजातीय समूह और बेघर परिवार।",
        "RSBY कवरेज: 28 फरवरी 2018 तक RSBY के तहत पंजीकृत परिवार स्वतः पात्र हैं।",
        "वरिष्ठ नागरिक: सितंबर 2024 से, 70 वर्ष या उससे अधिक आयु के सभी वरिष्ठ नागरिक, सामाजिक-आर्थिक स्थिति की परवाह किए बिना, ₹5 लाख तक के स्वास्थ्य कवरेज के लिए पात्र हैं।",
      ],
    },
    documents: {
      en: [
        "Aadhaar card or government-approved photo ID.",
        "Ration card or alternative family ID.",
        "Socio-Economic Caste Census (SECC) reference number (for rural families).",
        "Proof of Address and contact details (mobile, e-mail).",
        "Caste Certificate and Income Certificate (if applicable).",
        "Document proof of the current status of the family (joint or nuclear).",
      ],
      hi: [
        "आधार कार्ड या सरकार द्वारा स्वीकृत फोटो पहचान पत्र।",
        "राशन कार्ड या वैकल्पिक परिवार पहचान पत्र।",
        "SECC संदर्भ संख्या (ग्रामीण परिवारों के लिए)।",
        "पता प्रमाण और संपर्क विवरण (मोबाइल, ईमेल)।",
        "जाति प्रमाण पत्र और आय प्रमाण पत्र (यदि लागू हो)।",
        "परिवार की वर्तमान स्थिति का दस्तावेज़ी प्रमाण (संयुक्त या एकल)।",
      ],
    },
  },
  {
    id: "scheme-02",
    icon: "🤰", name: "Janani Suraksha Yojana (JSY)",
    desc: "Cash assistance for institutional delivery to reduce maternal and infant mortality.",
    eligibilitySummary: "Pregnant women, especially BPL households in low-performing states",
    officialLink: "https://nhm.gov.in/",
    detailLink: "https://www.myscheme.gov.in/schemes/jsy1",
    eligibility: {
      en: [
        "Low Performing States (LPS): All pregnant women delivering in a government or accredited private health institution are eligible — no marriage or BPL certification needed.",
        "High Performing States (HPS): Pregnant women delivering in government institutions are eligible only if they belong to a BPL household or SC/ST.",
        "Accredited Private Institutions: Across all states, the applicant must be from a BPL household or an SC/ST woman with a referral slip from health workers.",
        "Home Deliveries: Pregnant women from BPL households receive cash benefits for home births, regardless of age and number of children.",
        "Specific Exclusions/Criteria: Depending on state norms, benefit for general categories may be restricted to women aged 19+ and the first two live births only — SC/ST women are exempt from this parity limit.",
      ],
      hi: [
        "निम्न निष्पादन वाले राज्य (LPS): सरकारी या मान्यता प्राप्त निजी स्वास्थ्य संस्थान में प्रसव कराने वाली सभी गर्भवती महिलाएं पात्र हैं — इसके लिए विवाह या BPL प्रमाणन आवश्यक नहीं है।",
        "उच्च निष्पादन वाले राज्य (HPS): सरकारी संस्थानों में प्रसव कराने वाली गर्भवती महिलाएं केवल तभी पात्र हैं जब वे BPL परिवार या SC/ST से संबंधित हों।",
        "मान्यता प्राप्त निजी संस्थान: सभी राज्यों में, आवेदक को BPL परिवार या SC/ST महिला होना चाहिए और स्वास्थ्य कार्यकर्ता से रेफरल स्लिप होनी चाहिए।",
        "घर पर प्रसव: BPL परिवारों की गर्भवती महिलाओं को घर पर प्रसव के लिए नकद सहायता मिलती है, उम्र और बच्चों की संख्या की परवाह किए बिना।",
        "विशेष अपवाद/मानदंड: राज्य के नियमों के अनुसार, सामान्य श्रेणी के लिए लाभ 19 वर्ष या अधिक उम्र की महिलाओं और केवल पहले दो जीवित प्रसवों तक सीमित हो सकता है — SC/ST महिलाओं को इस सीमा से छूट है।",
      ],
    },
    documents: {
      en: [
        "Mother and Child Protection (MCP) Card.",
        "Photocopy of BPL Ration Card or Antyodaya Anna Yojana card.",
        "Photocopy of SC/ST status certificate (if applicable).",
        "Hospital Discharge Certificate (for institutional delivery).",
        "Copy of Aadhaar Card and passbook of the Aadhaar-linked bank account.",
      ],
      hi: [
        "मातृ एवं शिशु सुरक्षा (MCP) कार्ड।",
        "BPL राशन कार्ड या अंत्योदय अन्न योजना कार्ड की फोटोकॉपी।",
        "SC/ST स्थिति प्रमाण पत्र की फोटोकॉपी (यदि लागू हो)।",
        "अस्पताल डिस्चार्ज प्रमाण पत्र (संस्थागत प्रसव के लिए)।",
        "आधार कार्ड की प्रतिलिपि और आधार-लिंक्ड बैंक खाते की पासबुक।",
      ],
    },
  },
  {
    id: "scheme-03",
    icon: "🍼", name: "Janani Shishu Suraksha Karyakram (JSSK)",
    desc: "Free delivery, C-section and newborn care, including drugs, diet and transport.",
    eligibilitySummary: "All pregnant women delivering in public health institutions",
    officialLink: "https://nhm.gov.in/showlink.php?id=178",
    detailLink: "https://web.umang.gov.in/landing/scheme/detail/janani-shishu-suraksha-karyakram_jssk.html",
    eligibility: {
      en: [
        "Pregnant Women: All pregnant women who access government health facilities for delivery are entitled to completely free and cashless services (including C-sections, medicines, diagnostics and diet).",
        "Sick Newborns: Free treatment is extended to sick newborns and infants accessing government health facilities up to 30 days after birth.",
        "Universal Applicability: Eligibility is non-conditional — no income limit, no BPL condition, and no restriction on religion, caste or state.",
        "No Registration Bar: Entitlement is automatic; no prior registration is required for accessing emergency services.",
      ],
      hi: [
        "गर्भवती महिलाएं: प्रसव के लिए सरकारी स्वास्थ्य सुविधाओं का उपयोग करने वाली सभी गर्भवती महिलाएं पूर्णतः मुफ्त और नकद-रहित सेवाओं (सिजेरियन, दवाइयां, जांच, आहार सहित) की हकदार हैं।",
        "बीमार नवजात: जन्म के 30 दिन बाद तक सरकारी स्वास्थ्य सुविधाओं में आने वाले बीमार नवजातों और शिशुओं को मुफ्त उपचार दिया जाता है।",
        "सार्वभौमिक पात्रता: पात्रता गैर-शर्तीय है — कोई आय सीमा नहीं, कोई BPL शर्त नहीं, और धर्म, जाति या राज्य पर कोई प्रतिबंध नहीं।",
        "कोई पंजीकरण आवश्यक नहीं: पात्रता स्वचालित है; आपातकालीन सेवाओं के लिए पूर्व पंजीकरण की आवश्यकता नहीं है।",
      ],
    },
    documents: {
      en: [
        "Aadhaar Number/Card (helpful for record-keeping but not mandatory for emergency services).",
        "Mother and Child Health (MCH) / Mamta Card (if registered).",
        "Janani Suraksha Yojana (JSY) Card (if the applicant is a JSY beneficiary).",
        "Ration card.",
        "Address proof / Domicile certificate.",
      ],
      hi: [
        "आधार नंबर/कार्ड (रिकॉर्ड के लिए सहायक, पर आपातकालीन सेवाओं के लिए अनिवार्य नहीं)।",
        "मातृ एवं शिशु स्वास्थ्य (MCH) / ममता कार्ड (यदि पंजीकृत हो)।",
        "जननी सुरक्षा योजना (JSY) कार्ड (यदि आवेदक JSY लाभार्थी है)।",
        "राशन कार्ड।",
        "पता प्रमाण / निवास प्रमाण पत्र।",
      ],
    },
  },
  {
    id: "scheme-04",
    icon: "👶", name: "Pradhan Mantri Matru Vandana Yojana (PMMVY)",
    desc: "₹5,000 cash incentive for the first living child to support nutrition and rest.",
    eligibilitySummary: "Pregnant and lactating mothers, first child only",
    officialLink: "https://pmmvy.wcd.gov.in/",
    detailLink: "https://www.myscheme.gov.in/schemes/pmmvy",
    eligibility: {
      en: [
        "Covers pregnant women and lactating mothers who are at least 19 years old.",
        "Provides financial assistance primarily for the first live birth — ₹5,000 in installments to compensate for wage loss and promote healthcare.",
        "Also covers the birth of a second child exclusively if it is a girl, with a single incentive installment of ₹6,000.",
        "Applicants must belong to economically weaker/disadvantaged sections: net family income below ₹8 lakh/year, SC/ST women, or women who are 40% or fully disabled (Divyang Jan).",
        "Beneficiaries holding an MGNREGA Job Card, e-Shram card, BPL Ration Card, PMJAY card, or Kisan Samman Nidhi are also automatically eligible.",
        "Women in regular employment with Central/State Government or PSUs who receive similar paid maternity benefits are strictly excluded.",
      ],
      hi: [
        "यह योजना कम से कम 19 वर्ष की आयु की गर्भवती महिलाओं और स्तनपान कराने वाली माताओं को कवर करती है।",
        "मुख्य रूप से पहले जीवित बच्चे के लिए वित्तीय सहायता — मजदूरी हानि की पूर्ति और स्वास्थ्य देखभाल बढ़ाने के लिए किस्तों में ₹5,000।",
        "दूसरे बच्चे के जन्म पर केवल तभी कवर करती है जब वह बेटी हो — ₹6,000 की एकल प्रोत्साहन किस्त।",
        "आवेदकों को आर्थिक रूप से कमजोर/वंचित वर्गों से होना चाहिए: ₹8 लाख प्रति वर्ष से कम पारिवारिक आय, SC/ST महिलाएं, या 40% अथवा पूर्ण रूप से दिव्यांग (दिव्यांगजन) महिलाएं।",
        "MGNREGA जॉब कार्ड, ई-श्रम कार्ड, BPL राशन कार्ड, PMJAY कार्ड या किसान सम्मान निधि लाभार्थी भी स्वतः पात्र हैं।",
        "केंद्र/राज्य सरकार या सार्वजनिक उपक्रमों (PSU) में नियमित रोजगार में रहने वाली और समान वैतनिक मातृत्व लाभ प्राप्त करने वाली महिलाएं इस योजना से बाहर हैं।",
      ],
    },
    documents: {
      en: [
        "Aadhaar card or an alternative official identity proof.",
        "Mother and Child Protection (MCP) card or RCHI card.",
        "Details of an Aadhaar-mapped bank or post office account for Direct Benefit Transfer.",
        "Eligibility proof document (e.g., Income certificate, BPL card, e-Shram card, or MGNREGA card).",
        "Child birth certificate and child immunization details to claim later installments.",
      ],
      hi: [
        "आधार कार्ड या वैकल्पिक सरकारी पहचान प्रमाण।",
        "MCP कार्ड या RCHI कार्ड।",
        "प्रत्यक्ष लाभ हस्तांतरण (DBT) के लिए आधार-लिंक्ड बैंक या डाकघर खाते का विवरण।",
        "पात्रता प्रमाण दस्तावेज (जैसे आय प्रमाण पत्र, BPL कार्ड, ई-श्रम कार्ड, या MGNREGA कार्ड)।",
        "बाद की किस्तों के दावे के लिए बच्चे का जन्म प्रमाण पत्र और टीकाकरण विवरण।",
      ],
    },
  },
  {
    id: "scheme-05",
    icon: "🧒", name: "Rashtriya Bal Swasthya Karyakram (RBSK)",
    desc: "Free child health screening and early intervention for birth defects and deficiencies.",
    eligibilitySummary: "Children aged 0–18 years in the community",
    officialLink: "https://rbsk.mohfw.gov.in/",
    detailLink: "https://rbsk.mohfw.gov.in/RBSK/aboutusdata",
    eligibility: {
      en: [
        "Targets all children from birth up to 18 years of age residing in the community.",
        "Guarantees free comprehensive screening for the \"4 Ds\": Defects at birth, Diseases, Deficiencies, and Developmental delays, spanning 32 common health conditions.",
        "Newborns (0–6 weeks) are screened at public health delivery points by medical officers and at home by ASHA workers.",
        "Children aged 6 weeks to 6 years enrolled in Anganwadi Centres are actively screened by Mobile Health Teams (MHT).",
        "Older children/adolescents aged 6–18 years in Government and Government-aided schools are similarly covered by Mobile Health Teams.",
        "Any child diagnosed with a covered condition receives early intervention, free treatment, and surgical management (e.g., Cochlear implants) at the tertiary level, free of cost.",
      ],
      hi: [
        "यह कार्यक्रम समुदाय में रहने वाले जन्म से 18 वर्ष तक के सभी बच्चों को लक्षित करता है।",
        "\"4 D\" — जन्म दोष, रोग, कमियां, और विकासात्मक देरी — के लिए मुफ्त व्यापक स्क्रीनिंग की गारंटी देता है, जो 32 सामान्य स्वास्थ्य स्थितियों को कवर करता है।",
        "नवजात शिशुओं (0–6 सप्ताह) की जांच सार्वजनिक स्वास्थ्य केंद्रों पर चिकित्सा अधिकारियों द्वारा और घर पर आशा कार्यकर्ताओं द्वारा की जाती है।",
        "आंगनवाड़ी केंद्रों में नामांकित 6 सप्ताह से 6 वर्ष तक के बच्चों की जांच मोबाइल हेल्थ टीम (MHT) द्वारा सक्रिय रूप से की जाती है।",
        "सरकारी/सरकारी सहायता प्राप्त स्कूलों में 6–18 वर्ष के बड़े बच्चे और किशोर भी मोबाइल हेल्थ टीम द्वारा कवर किए जाते हैं।",
        "किसी स्वास्थ्य स्थिति से निदान बच्चे को शीघ्र हस्तक्षेप सेवाएं, मुफ्त उपचार, और तृतीयक स्तर पर सर्जिकल प्रबंधन (जैसे कॉकलियर इम्प्लांट) पूर्णतः मुफ्त मिलता है।",
      ],
    },
    documents: {
      en: [
        "Aadhaar Card or Birth Certificate of the child (for advanced hospital registration and tracking).",
        "Parents' identity proof and address proof.",
        "Anganwadi enrollment record or School ID card (for children above 6 weeks) to establish institutional mapping.",
        "Medical Referral slip from the Mobile Health Team (MHT) or local Medical Officers for advanced care at District Early Intervention Centers (DEIC).",
      ],
      hi: [
        "बच्चे का आधार कार्ड या जन्म प्रमाण पत्र (उन्नत अस्पताल पंजीकरण और ट्रैकिंग के लिए)।",
        "माता-पिता का पहचान प्रमाण और पता प्रमाण।",
        "6 सप्ताह से अधिक उम्र के बच्चों के लिए आंगनवाड़ी नामांकन रिकॉर्ड या स्कूल आईडी कार्ड।",
        "जिला शीघ्र हस्तक्षेप केंद्र (DEIC) में उन्नत देखभाल के लिए मोबाइल हेल्थ टीम (MHT) या स्थानीय चिकित्सा अधिकारियों द्वारा जारी मेडिकल रेफरल स्लिप।",
      ],
    },
  },
  {
    id: "scheme-06",
    icon: "💉", name: "Mission Indradhanush",
    desc: "Free immunisation drive covering vaccine-preventable childhood diseases.",
    eligibilitySummary: "Unvaccinated or partially vaccinated children and pregnant women",
    officialLink: "https://immunization.mohfw.gov.in/",
    detailLink: "https://www.indiascienceandtechnology.gov.in/st-visions/national-mission/mission-indradhanush-mi",
    eligibility: {
      en: [
        "Core target: all children under 2 years of age who are partially immunized or have never been immunized under the routine Universal Immunization Programme (UIP).",
        "Under expanded phases like Intensified Mission Indradhanush (IMI), on-demand vaccination is extended to children up to 5 years of age during specific drives.",
        "Includes pregnant women who need to be fully immunized (e.g., catching up on missed Tetanus vaccines).",
        "Functions as a broad catch-up initiative ensuring no socio-economic barriers prevent life-saving protection.",
        "Eligible beneficiaries receive free vaccines against Polio, Measles, Hepatitis B, Tetanus, Diphtheria, Tuberculosis, Whooping Cough, Pneumonia, and Japanese Encephalitis.",
      ],
      hi: [
        "मुख्य लक्ष्य समूह: 2 वर्ष से कम उम्र के वे सभी बच्चे जो नियमित सार्वभौमिक टीकाकरण कार्यक्रम (UIP) के तहत आंशिक रूप से टीकाकृत या पूरी तरह से अनटीकाकृत हैं।",
        "गहन मिशन इंद्रधनुष (IMI) जैसे विस्तारित चरणों के तहत, विशेष अभियानों के दौरान मांग पर 5 वर्ष तक के बच्चों को भी कवरेज दिया जाता है।",
        "इसमें वे गर्भवती महिलाएं भी शामिल हैं जिन्हें पूर्ण टीकाकरण की आवश्यकता है (जैसे छूटे हुए टिटनेस के टीके पूरे करना)।",
        "यह एक व्यापक कैच-अप पहल है जो सुनिश्चित करती है कि कोई भी सामाजिक-आर्थिक बाधा जीवन रक्षक सुरक्षा में रुकावट न बने।",
        "पात्र लाभार्थियों को पोलियो, खसरा, हेपेटाइटिस बी, टिटनेस, डिप्थीरिया, टीबी, काली खांसी, निमोनिया और जापानी इंसेफेलाइटिस के विरुद्ध मुफ्त टीके मिलते हैं।",
      ],
    },
    documents: {
      en: [
        "Mother and Child Protection (MCP) card or any previous immunization logbook.",
        "Aadhaar card or parent/guardian identity proof (helpful for maintaining health registries).",
        "Hospital discharge summary or birth certificate of the infant to map out the missed vaccine timeline.",
      ],
      hi: [
        "MCP कार्ड या पूर्व टीकाकरण लॉगबुक।",
        "आधार कार्ड या माता-पिता/अभिभावक का पहचान प्रमाण (स्वास्थ्य रिकॉर्ड बनाए रखने के लिए सहायक)।",
        "छूटे हुए टीकों की समय-सीमा तय करने के लिए अस्पताल डिस्चार्ज समरी या शिशु का जन्म प्रमाण पत्र।",
      ],
    },
  },
];

// ─── Scheme form <-> data helpers ────────────────────────────────────────────
// The admin form edits bilingual eligibility/document lists as plain
// newline-separated textareas; these helpers convert to/from the array shape
// the rest of the app (and the read-only modal) expects.
const BLANK_SCHEME_FORM = {
  icon: "🏥",
  name: "",
  desc: "",
  eligibilitySummary: "",
  officialLink: "",
  detailLink: "",
  eligibilityEn: "",
  eligibilityHi: "",
  documentsEn: "",
  documentsHi: "",
};

const linesToList = (str) => str.split("\n").map((s) => s.trim()).filter(Boolean);
const listToLines = (arr) => (arr || []).join("\n");

function schemeToForm(scheme) {
  return {
    icon: scheme.icon || "🏥",
    name: scheme.name || "",
    desc: scheme.desc || "",
    eligibilitySummary: scheme.eligibilitySummary || "",
    officialLink: scheme.officialLink || "",
    detailLink: scheme.detailLink || "",
    eligibilityEn: listToLines(scheme.eligibility?.en),
    eligibilityHi: listToLines(scheme.eligibility?.hi),
    documentsEn: listToLines(scheme.documents?.en),
    documentsHi: listToLines(scheme.documents?.hi),
  };
}

function formToScheme(form, existingId) {
  return {
    id: existingId || `scheme-${Date.now()}`,
    icon: form.icon.trim() || "🏥",
    name: form.name.trim(),
    desc: form.desc.trim(),
    eligibilitySummary: form.eligibilitySummary.trim(),
    officialLink: form.officialLink.trim(),
    detailLink: form.detailLink.trim(),
    eligibility: { en: linesToList(form.eligibilityEn), hi: linesToList(form.eligibilityHi) },
    documents: { en: linesToList(form.documentsEn), hi: linesToList(form.documentsHi) },
  };
}

// ─── Add / Edit Scheme modal (admin only) ────────────────────────────────────
function SchemeFormModal({ mode, initial, onCancel, onSubmit }) {
  const [form, setForm] = useState(() => (initial ? schemeToForm(initial) : BLANK_SCHEME_FORM));
  const [formLang, setFormLang] = useState("en");
  const [error, setError] = useState("");

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.desc.trim() || !form.eligibilitySummary.trim()) {
      setError("Scheme name, description and eligibility summary are required.");
      return;
    }
    if (!linesToList(form.eligibilityEn).length || !linesToList(form.documentsEn).length) {
      setError("Add at least one English eligibility point and one English document.");
      return;
    }
    setError("");
    onSubmit(formToScheme(form, initial?.id));
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {mode === "edit" ? "✏️ Edit Government Scheme" : "➕ Add New Government Scheme"}
          </div>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="form-error-banner">⚠️ {error}</div>}

            <div className="scheme-icon-name-row">
              <div className="form-group">
                <label className="form-label">Icon</label>
                <input
                  className="form-input scheme-icon-input"
                  value={form.icon}
                  onChange={(e) => set("icon", e.target.value)}
                  maxLength={4}
                  placeholder="🏥"
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Scheme Name<span className="required">*</span></label>
                <input
                  className="form-input"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Ayushman Bharat (PM-JAY)"
                />
              </div>
            </div>

            <div className="form-group mb-4">
              <label className="form-label">Short Description<span className="required">*</span></label>
              <textarea
                className="form-textarea"
                style={{ minHeight: 56 }}
                value={form.desc}
                onChange={(e) => set("desc", e.target.value)}
                placeholder="One-line summary shown on the scheme card"
              />
            </div>

            <div className="form-group mb-4">
              <label className="form-label">Eligibility Summary (shown on card)<span className="required">*</span></label>
              <input
                className="form-input"
                value={form.eligibilitySummary}
                onChange={(e) => set("eligibilitySummary", e.target.value)}
                placeholder="e.g. Families listed under SECC database"
              />
            </div>

            <div className="form-grid mb-4">
              <div className="form-group">
                <label className="form-label">Official Website Link</label>
                <input
                  className="form-input"
                  type="url"
                  value={form.officialLink}
                  onChange={(e) => set("officialLink", e.target.value)}
                  placeholder="https://..."
                />
              </div>
              <div className="form-group">
                <label className="form-label">Detailed Eligibility Criteria Link</label>
                <input
                  className="form-input"
                  type="url"
                  value={form.detailLink}
                  onChange={(e) => set("detailLink", e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="form-section-title">📋 Eligibility &amp; Documents Content</div>

            <div className="btn-tabs lang-toggle-row">
              <button type="button" className={`btn-tab ${formLang === "en" ? "active" : ""}`} onClick={() => setFormLang("en")}>
                English
              </button>
              <button type="button" className={`btn-tab ${formLang === "hi" ? "active" : ""}`} onClick={() => setFormLang("hi")}>
                हिंदी
              </button>
            </div>

            {formLang === "en" ? (
              <>
                <div className="form-group mb-4">
                  <label className="form-label">Eligibility Points (English)<span className="required">*</span></label>
                  <textarea
                    className="form-textarea"
                    value={form.eligibilityEn}
                    onChange={(e) => set("eligibilityEn", e.target.value)}
                    placeholder={"All pregnant women delivering in public health institutions\nNo income limit or BPL condition"}
                  />
                  <span className="textarea-hint">One point per line</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Documents Required (English)<span className="required">*</span></label>
                  <textarea
                    className="form-textarea"
                    value={form.documentsEn}
                    onChange={(e) => set("documentsEn", e.target.value)}
                    placeholder={"Aadhaar card or government-approved photo ID\nRation card"}
                  />
                  <span className="textarea-hint">One document per line</span>
                </div>
              </>
            ) : (
              <>
                <div className="form-group mb-4">
                  <label className="form-label">पात्रता बिंदु (हिंदी)</label>
                  <textarea
                    className="form-textarea"
                    value={form.eligibilityHi}
                    onChange={(e) => set("eligibilityHi", e.target.value)}
                    placeholder={"सरकारी स्वास्थ्य सुविधाओं में प्रसव कराने वाली सभी गर्भवती महिलाएं"}
                  />
                  <span className="textarea-hint">प्रति पंक्ति एक बिंदु</span>
                </div>
                <div className="form-group">
                  <label className="form-label">आवश्यक दस्तावेज़ (हिंदी)</label>
                  <textarea
                    className="form-textarea"
                    value={form.documentsHi}
                    onChange={(e) => set("documentsHi", e.target.value)}
                    placeholder={"आधार कार्ड\nराशन कार्ड"}
                  />
                  <span className="textarea-hint">प्रति पंक्ति एक दस्तावेज़</span>
                </div>
              </>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline-purple" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-gold">
              {mode === "edit" ? "Update Scheme" : "Save Scheme"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function GovtSchemes({ schemes, setSchemes, isAdmin, toast }) {
  // modal = { scheme, type: 'eligibility' | 'documents' } | null
  const [modal, setModal] = useState(null);
  const [lang, setLang] = useState("en");
  const [formModal, setFormModal] = useState(null); // { mode: 'add' | 'edit', scheme } | null
  const [deleteTarget, setDeleteTarget] = useState(null);

  const openModal = (scheme, type) => {
    setLang("en");
    setModal({ scheme, type });
  };
  const closeModal = () => setModal(null);

  const isEligibility = modal?.type === "eligibility";
  const listData = modal ? (isEligibility ? modal.scheme.eligibility : modal.scheme.documents)[lang] : [];

  const openAddForm  = () => setFormModal({ mode: "add", scheme: null });
  const openEditForm = (scheme) => setFormModal({ mode: "edit", scheme });
  const closeForm    = () => setFormModal(null);

  const handleFormSubmit = (scheme) => {
    if (formModal.mode === "edit") {
      setSchemes((prev) => prev.map((s) => (s.id === scheme.id ? scheme : s)));
      toast?.("Scheme updated successfully!", "success", scheme.name);
    } else {
      setSchemes((prev) => [...prev, scheme]);
      toast?.("Scheme added successfully!", "success", scheme.name);
    }
    setFormModal(null);
  };

  const requestDelete = (scheme) => setDeleteTarget(scheme);
  const cancelDelete  = () => setDeleteTarget(null);
  const confirmDeleteScheme = () => {
    setSchemes((prev) => prev.filter((s) => s.id !== deleteTarget.id));
    toast?.("Scheme deleted", "success", deleteTarget.name);
    setDeleteTarget(null);
  };

  return (
    <div className="page-body">
      <div className="card card-ai mb-4">
        <div className="card-header">
          <div className="card-title">🏛️ Govt Scheme Suggestions</div>
          <div className="flex items-center gap-2">
            <span className="badge badge-gold">{schemes.length} Schemes</span>
            {isAdmin && (
              <button className="btn btn-gold btn-sm" onClick={openAddForm}>
                ➕ Add New Scheme
              </button>
            )}
          </div>
        </div>
        <div className="card-body" style={{ color: "var(--text-muted)", fontSize: 13, padding: "16px 24px" }}>
          {isAdmin
            ? "National health schemes your patients may be eligible for — add, edit or remove schemes for everyone to see."
            : "National health schemes you may be eligible for — tap a card to see eligibility and required documents."}
        </div>
      </div>

      <div className="stats-grid">
        {schemes.map((s) => (
          <div key={s.id} className="stat-card">
            <div style={{ fontSize: 26 }}>{s.icon}</div>
            <div style={{ fontWeight: 700, color: "var(--text-dark)", fontSize: 14, lineHeight: 1.3 }}>
              {s.name}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>{s.desc}</div>
            <div style={{ fontSize: 11, color: "var(--purple-primary)", fontWeight: 600 }}>
              Eligibility: {s.eligibilitySummary}
            </div>
            <div className="scheme-card-actions">
              <button
                className="btn btn-outline-purple btn-sm"
                onClick={() => openModal(s, "eligibility")}
              >
                📋 Eligibility
              </button>
              <button
                className="btn btn-outline-gold btn-sm"
                onClick={() => openModal(s, "documents")}
              >
                📄 Document Required
              </button>
            </div>
            {isAdmin && (
              <div className="scheme-card-admin-row">
                <button className="btn btn-outline-purple btn-sm" onClick={() => openEditForm(s)}>
                  ✏️ Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => requestDelete(s)}>
                  🗑️ Delete
                </button>
              </div>
            )}
          </div>
        ))}

        {schemes.length === 0 && (
          <div className="text-muted text-sm" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "30px 0" }}>
            No schemes added yet{isAdmin ? ' — click "Add New Scheme" to create one.' : "."}
          </div>
        )}
      </div>

      {/* Eligibility / Document Required modal — bilingual (EN / HI), view-only */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {modal.scheme.icon} {modal.scheme.name}
                <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--purple-mid)", marginTop: 2 }}>
                  {isEligibility ? "Eligibility Criteria / पात्रता मानदंड" : "Document Required / आवश्यक दस्तावेज़"}
                </span>
              </div>
              <button className="modal-close" onClick={closeModal}>✕</button>
            </div>

            <div className="modal-body">
              <div className="btn-tabs lang-toggle-row">
                <button
                  className={`btn-tab ${lang === "en" ? "active" : ""}`}
                  onClick={() => setLang("en")}
                >
                  English
                </button>
                <button
                  className={`btn-tab ${lang === "hi" ? "active" : ""}`}
                  onClick={() => setLang("hi")}
                >
                  हिंदी
                </button>
              </div>

              {isEligibility && (
                <div className="scheme-links">
                  <a href={modal.scheme.officialLink} target="_blank" rel="noopener noreferrer" className="scheme-link-pill">
                    🌐 {lang === "en" ? "Official Website" : "आधिकारिक वेबसाइट"}
                  </a>
                  <a href={modal.scheme.detailLink} target="_blank" rel="noopener noreferrer" className="scheme-link-pill">
                    🔗 {lang === "en" ? "Detailed Eligibility Criteria" : "विस्तृत पात्रता मानदंड"}
                  </a>
                </div>
              )}

              <ul className="scheme-list">
                {listData.map((point, i) => (
                  <li key={i} className="scheme-list-item">{point}</li>
                ))}
              </ul>
            </div>

            <div className="modal-footer">
              <button className="btn btn-outline-purple" onClick={closeModal}>
                {lang === "en" ? "Close" : "बंद करें"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit scheme modal — admin only */}
      {formModal && (
        <SchemeFormModal
          mode={formModal.mode}
          initial={formModal.scheme}
          onCancel={closeForm}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Delete confirmation modal — admin only */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">🗑️ Delete Scheme</div>
              <button className="modal-close" onClick={cancelDelete}>✕</button>
            </div>
            <div className="modal-body">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
              This will remove it from both the admin and patient views. This action cannot be undone.
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline-purple" onClick={cancelDelete}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDeleteScheme}>Delete Scheme</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Medical Analysis — OCR + AI Document Reader ─────────────────────────────
// Pipeline: image → OCR (Tesseract.js, on-device) → extracted text shown to
// the user → ONLY that text (never the image) is sent to the AI for a short,
// structured summary. This keeps token usage low and matches the "OCR first,
// AI only when required" rule from the feature spec.

// Tesseract.js is loaded from a CDN on first use instead of being bundled, so
// no new dependency/file is needed — it attaches itself to `window.Tesseract`.
//
// Because it's loaded via a plain <script> tag (not npm/webpack), Tesseract.js
// can't auto-resolve its own worker/core/lang file locations the way it would
// in a bundled app — so we point it at the CDN explicitly. NOTE: corePath must
// be a *directory* containing all 4 core build variants (lstm/simd/legacy) —
// pointing it at one specific .js file stops Tesseract from picking the right
// build for the user's device and is the actual reason OCR was failing.
const TESSERACT_CDN = {
  workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
  corePath:   "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0",
  langPath:   "https://tessdata.projectnaptha.com/4.0.0",
};

function loadTesseract() {
  if (typeof window !== "undefined" && window.Tesseract) {
    return Promise.resolve(window.Tesseract);
  }
  if (!loadTesseract._promise) {
    loadTesseract._promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      script.async = true;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () =>
        reject(new Error("Couldn't load the OCR engine. Check your internet connection and try again."));
      document.head.appendChild(script);
    });
  }
  return loadTesseract._promise;
}

// ── Image preprocessing before OCR ──────────────────────────────────────────
// Camera photos come straight from the device sensor at full resolution and,
// on many phones, carry an EXIF orientation tag that a plain canvas draw
// ignores — so a portrait photo taken via capture="environment" can land in
// Tesseract sideways or upside-down. That's the actual reason "Take Photo"
// OCR has been so much worse than "Upload Document": gallery photos have
// usually already been re-encoded (which bakes the rotation in), fresh camera
// captures haven't. createImageBitmap's imageOrientation:"from-image" applies
// that EXIF rotation for us before anything touches a canvas.
//
// We also upscale small/cropped shots (tiny printed text — like a medicine
// pack's expiry line — needs a decent number of pixels per character to OCR
// reliably) and convert to a contrast-stretched grayscale image, which helps
// both slightly blurry camera shots and the low-contrast, often-reflective
// print on blister foil and medicine boxes.
async function preprocessImageForOCR(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file; // last resort: let Tesseract read the original file directly
    }
  }

  const MIN_DIM = 1200; // upscale so small printed text stays legible
  const MAX_DIM = 2400; // cap so huge camera photos don't stall OCR
  let { width, height } = bitmap;
  const longest = Math.max(width, height);
  let scale = 1;
  if (longest < MIN_DIM) scale = MIN_DIM / longest;
  else if (longest > MAX_DIM) scale = MAX_DIM / longest;
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const px = imgData.data;
    let min = 255, max = 0;
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      gray[j] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(max - min, 1);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const stretched = ((gray[j] - min) / range) * 255;
      px[i] = px[i + 1] = px[i + 2] = stretched;
    }
    ctx.putImageData(imgData, 0, 0);
  } catch {
    // getImageData can throw on a tainted/cross-origin canvas — extremely
    // unlikely for a locally captured file, but fall back to the plain
    // (oriented + resized) image rather than losing the OCR attempt entirely.
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || file), "image/png");
  });
}

// ── Expiry detection (Medicine Pack) — pure pattern matching, no AI call ────
const MONTH_MAP = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function buildExpiryResult(month, year, day) {
  if (!month || month < 1 || month > 12) return null;
  if (year < 100) year += 2000;
  if (year < 2000 || year > 2099) return null;

  // A pack is treated as valid through the end of the printed day/month.
  const expiryDate = day
    ? new Date(year, month - 1, day, 23, 59, 59)
    : new Date(year, month, 0, 23, 59, 59);
  if (isNaN(expiryDate.getTime())) return null;

  const daysRemaining = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
  const dateLabel = day
    ? `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`
    : `${String(month).padStart(2, "0")}/${year}`;

  return { dateLabel, status: daysRemaining >= 0 ? "Valid" : "Expired", daysRemaining };
}

// Blister/foil packs frequently print the expiry date slightly above or below
// the "EXP" label's baseline (a different text row, or a raised/embossed
// batch-style font) rather than cleanly in line with it. OCR still reads both
// as text, but the extra vertical offset means: (a) stray characters or extra
// spaces can land between the keyword and the actual date, and (b) the small,
// often shiny-foil digits get misread more than plain paragraph text (O/0,
// I/1, S/5, B/8 confusion; single digits split apart by a phantom space).
// tightenNumericNoise/fixConfusableDigits clean up exactly that noise, scoped
// to a short window right after the keyword so we never touch unrelated text.
function tightenNumericNoise(s) {
  return s
    .replace(/(\d)\s+(?=\d)/g, "$1")
    .replace(/(\d)\s+([\/\-.])/g, "$1$2")
    .replace(/([\/\-.])\s+(\d)/g, "$1$2");
}

function fixConfusableDigits(s) {
  return s
    .replace(/[OQ]/g, "0")
    .replace(/[IL|]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2")
    .replace(/G/g, "9");
}

function tryParseDateWindow(windowRaw) {
  // Try the raw window first, then a noise-tightened version, then a version
  // with common OCR digit misreads corrected — in that order, so we never
  // "correct" a perfectly clean date into something wrong.
  const numericCandidates = [
    windowRaw,
    tightenNumericNoise(windowRaw),
    fixConfusableDigits(tightenNumericNoise(windowRaw)),
  ];

  for (const w of numericCandidates) {
    // NOTE: the middle group tries \d{4} BEFORE \d{1,2}. Regex alternation
    // tries left-to-right and stops at the first option that lets the match
    // succeed — with \d{1,2} listed first, "2027" would match only its first
    // 2 digits ("20"), which then got promoted via the year<100 rule below
    // into 2020 — i.e. almost every real-world MM/YYYY expiry in the 2020s
    // was silently misread as "2020", which is why every pack looked
    // "Expired" the same way.
    const numeric = w.match(/^\s*[:.\-]?\s*(\d{1,2})[\/\-.](\d{4}|\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (numeric) {
      const result = numeric[3]
        ? buildExpiryResult(parseInt(numeric[2], 10), parseInt(numeric[3], 10), parseInt(numeric[1], 10))
        : buildExpiryResult(parseInt(numeric[1], 10), parseInt(numeric[2], 10), null);
      if (result) return result;
    }
  }

  // Textual-month forms: "EXP JUN 2027", "EXPIRY: JUN-27" — matched against
  // the raw window since letters (not digits) carry the meaning here.
  const textual = windowRaw.match(/^\s*[:.\-]?\s*([A-Z]{3,9})[\s\-.]?(\d{2,4})/);
  if (textual && MONTH_MAP[textual[1].slice(0, 3)]) {
    const result = buildExpiryResult(MONTH_MAP[textual[1].slice(0, 3)], parseInt(textual[2], 10), null);
    if (result) return result;
  }

  return null;
}

function parseExpiryFromText(rawText) {
  const text = rawText.toUpperCase().replace(/\s+/g, " ");
  const keywordRe = /EXP(?:IRY)?\.?(?:\s*DATE)?|USE\s*BY|BEST\s*BEFORE/g;

  // Scan every occurrence of an expiry keyword, not just the first — packs
  // often print "MFG ... EXP ..." and, if the label and date sit on slightly
  // different lines/baselines, OCR can occasionally pick up a stray keyword-
  // like fragment before the real one. Trying each occurrence in turn (widening
  // the look-ahead window a bit past just the very next token) means one bad
  // match doesn't stop us from finding the real date.
  let match;
  while ((match = keywordRe.exec(text)) !== null) {
    const windowText = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const result = tryParseDateWindow(windowText);
    if (result) return result;
  }

  return null;
}

// ── Small helpers ───────────────────────────────────────────────────────────
function hashText(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

async function analyzeDocumentWithAI(systemPrompt, ocrText) {
  const { response } = await analyzeMedicalDocument(systemPrompt, ocrText);
  if (!response) throw new Error("The AI didn't return a usable response. Please try again.");
  return response;
}

// ── Per-document-type configuration ─────────────────────────────────────────
const ANALYSIS_TYPES = {
  prescription: {
    key: "prescription",
    icon: "💊",
    title: "Doctor Prescription",
    desc: "Upload a doctor's handwritten or printed prescription and get a structured summary.",
    uploadLabel: "Upload Prescription",
    accent: "purple",
    systemPrompt: `You are a careful medical-document assistant helping an ASHA health worker in India read a doctor's prescription. You will be given OCR-extracted text from a prescription photo — it may contain OCR mistakes or be incomplete.

Reply in PLAIN TEXT ONLY (no markdown asterisks, no numbered lists) using EXACTLY this structure, and keep the whole reply under 300 words:

Doctor:
<name, or "Not detected">

Patient:
<name, or "Not detected">

Medicines Prescribed:
- <medicine 1>
- <medicine 2>

Dosage Instructions:
- <instruction>

Important Notes:
- <note>

Warnings:
- This is AI-generated and must be verified by a healthcare professional.

If a field cannot be read from the OCR text, write "Not detected" rather than guessing.`,
  },
  lab: {
    key: "lab",
    icon: "🧪",
    title: "Lab Report",
    desc: "Upload blood test, urine test, thyroid report, CBC, sugar report, etc.",
    uploadLabel: "Upload Lab Report",
    accent: "gold",
    systemPrompt: `You are a careful lab-report analysis assistant helping an ASHA health worker in India interpret a patient's lab report. You will be given OCR-extracted text from a lab report photo — it may contain OCR mistakes or be incomplete.

Reply in PLAIN TEXT ONLY (no markdown asterisks, no numbered lists) using EXACTLY this structure, and keep the whole reply under 300 words:

Normal Parameters:
- <parameter: value>

Abnormal Parameters:
- <parameter: value>

Possible Health Concerns:
- <concern>

Lifestyle Recommendations:
- <recommendation>

Suggested Questions For Doctor:
- <question>

Risk Level:
<Low, Medium, or High>

Medical Disclaimer:
This analysis is informational only and is not a medical diagnosis.

If a section has nothing to report, write "None detected" instead of leaving it blank.`,
  },
  medicine: {
    key: "medicine",
    icon: "💉",
    title: "Medicine Pack",
    desc: "Upload a medicine strip, bottle, or box image to identify medicine details.",
    uploadLabel: "Upload Medicine",
    accent: "green",
    systemPrompt: `You are a careful medicine-identification assistant helping an ASHA health worker in India read a medicine strip, bottle, or box. You will be given OCR-extracted text from the packaging — it may contain OCR mistakes or be incomplete.

Reply in PLAIN TEXT ONLY (no markdown asterisks, no numbered lists) using EXACTLY this structure, and keep the whole reply under 300 words:

Medicine Name:
<name, or "Not detected">

Medicine Type:
<Tablet, Syrup, Capsule, Injection, or Other>

Common Uses:
- <use>

How To Use:
- <instruction>

Possible Side Effects:
- <side effect>

Storage Instructions:
- <instruction>

Important Warnings:
- <warning>

Medical Disclaimer:
Consult a healthcare professional before taking any medicine.

Do not comment on the expiry date — that is calculated separately and shown above your summary.`,
  },
};

// ── Renders the AI's structured plain-text reply with light formatting ─────
function riskBadgeClass(value) {
  const v = value.toLowerCase();
  if (v.includes("high")) return "badge-red";
  if (v.includes("medium")) return "badge-gold";
  if (v.includes("low")) return "badge-green";
  return "badge-purple";
}

function AnalysisOutput({ text }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="analysis-output">
      {lines.map((line, i) => {
        const headerOnly = line.match(/^([A-Za-z][A-Za-z /&]{2,40}):$/);
        if (headerOnly) {
          return <div key={i} className="analysis-heading">{headerOnly[1]}</div>;
        }
        const bullet = line.match(/^[-•]\s*(.+)$/);
        if (bullet) {
          return <div key={i} className="analysis-bullet">• {bullet[1]}</div>;
        }
        const kv = line.match(/^([A-Za-z][A-Za-z /&]{2,40}):\s*(.+)$/);
        if (kv) {
          const label = kv[1];
          const value = kv[2];
          const isRisk = /risk level/i.test(label);
          return (
            <div key={i} className="analysis-kv">
              <span className="analysis-kv-label">{label}:</span>{" "}
              {isRisk ? (
                <span className={`badge ${riskBadgeClass(value)}`}>{value}</span>
              ) : (
                <span className="analysis-kv-value">{value}</span>
              )}
            </div>
          );
        }
        return <div key={i} className="analysis-line">{line}</div>;
      })}
    </div>
  );
}

// ── Upload + OCR + AI flow for a single document type ──────────────────────
function MedicalUploadCard({ meta, onBack, cache, setCache }) {
  const [file, setFile]       = useState(null);
  const [preview, setPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus]   = useState("idle"); // idle | ocr | analyzing | done | error
  const [ocrText, setOcrText] = useState("");
  const [ocrPct, setOcrPct]   = useState(0);
  const [showOcr, setShowOcr] = useState(false);
  const [analysis, setAnalysis] = useState("");
  const [expiry, setExpiry]   = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const galleryInputRef = useRef(null);
  const cameraInputRef  = useRef(null);

  const acceptFile = (f) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErrorMsg("Please upload an image file (JPG or PNG).");
      setStatus("error");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setErrorMsg("That image is larger than 8 MB. Please upload a smaller photo.");
      setStatus("error");
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setStatus("idle");
    setOcrText(""); setAnalysis(""); setExpiry(null); setErrorMsg(""); setFromCache(false);
  };

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null); setPreview(null); setStatus("idle");
    setOcrText(""); setOcrPct(0); setAnalysis(""); setExpiry(null);
    setErrorMsg(""); setFromCache(false); setShowOcr(false);
  };

  const runAnalysis = async () => {
    if (!file) return;
    setErrorMsg(""); setFromCache(false);
    try {
      // 1) OCR runs first, on-device — this is the only thing that "looks" at the image
      setStatus("ocr"); setOcrPct(0);
      const Tesseract = await loadTesseract();
      const worker = await Tesseract.createWorker("eng", 1, {
        ...TESSERACT_CDN,
        logger: (m) => {
          if (m.status === "recognizing text") setOcrPct(Math.round(m.progress * 100));
        },
      });
      // Medicine packs are mostly sparse, scattered printed lines (name, batch,
      // MFG/EXP) rather than paragraph text, so the default automatic page
      // segmentation sometimes misses or garbles the small expiry line —
      // SPARSE_TEXT is tuned for exactly this "isolated lines of text" layout.
      if (meta.key === "medicine") {
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      }
      const processedFile = await preprocessImageForOCR(file);
      const { data } = await worker.recognize(processedFile);
      await worker.terminate();
      const text = (data?.text || "").trim();
      setOcrText(text);

      if (!text) {
        throw new Error("Couldn't read any text from this image. Try a clearer, well-lit photo.");
      }

      // 2) Medicine packs: expiry is detected straight from OCR text, no AI needed
      if (meta.key === "medicine") {
        setExpiry(parseExpiryFromText(text));
      }

      // 3) Re-use a cached AI summary for identical text instead of calling the AI again.
      // TODO: back this with Firestore (medical_reports / medicine_cache / lab_reports /
      // prescriptions collections, as in the spec) once Firebase is wired into this app —
      // this in-memory cache only lasts the current session.
      const cacheKey = `${meta.key}:${hashText(text)}`;
      if (cache[cacheKey]) {
        setAnalysis(cache[cacheKey]);
        setFromCache(true);
        setStatus("done");
        return;
      }

      // 4) Only the extracted TEXT is sent to the AI — never the image — to keep cost low
      setStatus("analyzing");
      const result = await analyzeDocumentWithAI(meta.systemPrompt, text);
      setAnalysis(result);
      setCache((prev) => ({ ...prev, [cacheKey]: result }));
      setStatus("done");
    } catch (err) {
      setErrorMsg(err.message || "Something went wrong. Please try again.");
      setStatus("error");
    }
  };

  return (
    <div className="page-body">
      <div className="medical-type-header">
        <button className="btn btn-outline-purple btn-sm" onClick={onBack}>← Back</button>
        <div className="medical-type-heading">
          <span style={{ fontSize: 28 }}>{meta.icon}</span>
          <div>
            <div className="card-title" style={{ marginBottom: 2 }}>{meta.title}</div>
            <div className="text-sm text-muted">{meta.desc}</div>
          </div>
        </div>
      </div>

      <div className="card card-ai">
        <div className="card-body">
          {!file && (
            <div
              className={`upload-zone ${dragOver ? "dragover" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                acceptFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => acceptFile(e.target.files?.[0])}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={(e) => acceptFile(e.target.files?.[0])}
              />
              <div className="upload-icon">{meta.icon}</div>
              <div className="upload-title">{meta.uploadLabel}</div>
              <div className="upload-sub">Drag a photo here, or choose an option below · JPG or PNG</div>
              <div className="flex gap-2 mt-2" style={{ justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-outline-purple btn-sm"
                  onClick={() => galleryInputRef.current?.click()}
                >
                  🖼️ Upload Document
                </button>
                <button
                  type="button"
                  className="btn btn-gold btn-sm"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  📷 Take Photo
                </button>
              </div>
            </div>
          )}

          {errorMsg && status === "error" && !file && (
            <div className="error-banner mt-2">⚠️ {errorMsg}</div>
          )}

          {file && (
            <div className="medical-upload-active">
              <div className="medical-preview-row">
                <img src={preview} alt="Uploaded document" className="medical-preview-thumb" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: "var(--text-dark)" }} className="truncate">{file.name}</div>
                  <div className="text-sm text-muted">{(file.size / 1024).toFixed(0)} KB</div>
                  {status === "idle" && (
                    <div className="flex gap-2 mt-2" style={{ flexWrap: "wrap" }}>
                      <button className="btn btn-gold btn-sm" onClick={runAnalysis}>🔍 Run Analysis</button>
                      <button className="btn btn-outline-purple btn-sm" onClick={reset}>Choose Different Image</button>
                    </div>
                  )}
                </div>
              </div>

              {(status === "ocr" || status === "analyzing") && (
                <div className="medical-progress">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="spinner"
                      style={{ borderColor: "rgba(124,58,237,0.25)", borderTopColor: "var(--purple-primary)", width: 16, height: 16 }}
                    />
                    <span className="text-sm" style={{ color: "var(--purple-deep)", fontWeight: 600 }}>
                      {status === "ocr" ? "Reading text from the image…" : "Analyzing with AI…"}
                    </span>
                  </div>
                  {status === "ocr" && (
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${ocrPct}%` }} />
                    </div>
                  )}
                </div>
              )}

              {errorMsg && status === "error" && (
                <div className="error-banner mt-2">
                  ⚠️ {errorMsg}
                  <div className="mt-2">
                    <button className="btn btn-outline-purple btn-sm" onClick={runAnalysis}>Try Again</button>
                  </div>
                </div>
              )}

              {ocrText && (
                <div className="ocr-text-block">
                  <button className="ocr-text-toggle" onClick={() => setShowOcr((p) => !p)}>
                    {showOcr ? "▾" : "▸"} Extracted Text (OCR)
                  </button>
                  {showOcr && <div className="ocr-text-box">{ocrText}</div>}
                </div>
              )}

              {meta.key === "medicine" && expiry && (
                <div className={`expiry-banner ${expiry.status === "Valid" ? "valid" : "expired"}`}>
                  <div style={{ fontSize: 22 }}>{expiry.status === "Valid" ? "✅" : "⛔"}</div>
                  <div>
                    <div style={{ fontWeight: 700 }}>Medicine Status: {expiry.status}</div>
                    <div className="text-sm">
                      Expiry detected: {expiry.dateLabel} ·{" "}
                      {expiry.daysRemaining >= 0
                        ? `${expiry.daysRemaining} day(s) remaining`
                        : `Expired ${Math.abs(expiry.daysRemaining)} day(s) ago`}
                    </div>
                  </div>
                </div>
              )}
              {meta.key === "medicine" && (status === "analyzing" || status === "done") && !expiry && (
                <div className="expiry-banner unknown">
                  <div style={{ fontSize: 22 }}>❔</div>
                  <div>
                    <div style={{ fontWeight: 700 }}>Expiry date not detected</div>
                    <div className="text-sm">Try a clearer photo of the expiry print, or check it manually.</div>
                  </div>
                </div>
              )}

              {analysis && (
                <div className="card mt-4">
                  <div className="card-header">
                    <div className="card-title">📝 AI Summary</div>
                    {fromCache && <span className="badge badge-green">⚡ From cache · no AI call needed</span>}
                  </div>
                  <div className="card-body">
                    <AnalysisOutput text={analysis} />
                    <div className="mt-4">
                      <button className="btn btn-outline-purple btn-sm" onClick={reset}>
                        Analyze Another {meta.title}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Top-level page: three feature cards, or the upload flow for one of them ─
function MedicalAnalysis() {
  const [activeType, setActiveType] = useState(null); // null | "prescription" | "lab" | "medicine"
  const [cache, setCache] = useState({}); // AI-result cache for this session, keyed by type+text hash

  if (activeType) {
    return (
      <MedicalUploadCard
        key={activeType}
        meta={ANALYSIS_TYPES[activeType]}
        onBack={() => setActiveType(null)}
        cache={cache}
        setCache={setCache}
      />
    );
  }

  return (
    <div className="page-body">
      <div className="card card-ai mb-4">
        <div className="card-header">
          <div className="card-title">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <ClipboardLogoIcon size={22} />
              Medical Analysis
            </span>
            <span className="ai-badge">✨ OCR + AI Analysis</span>
          </div>
        </div>
        <div className="card-body" style={{ color: "var(--text-muted)", fontSize: 13, padding: "16px 24px" }}>
          Upload a photo of a prescription, lab report, or medicine pack. Text is read on-device with OCR
          first — only that text, never the image, is sent to AI for a short, structured summary.
        </div>
      </div>

      <div className="feature-grid">
        {Object.values(ANALYSIS_TYPES).map((t) => (
          <div key={t.key} className={`feature-card feature-card-${t.accent}`}>
            <div className="feature-icon-circle">{t.icon}</div>
            <div className="feature-title">{t.title}</div>
            <div className="feature-desc">{t.desc}</div>
            <button className="btn btn-gold" onClick={() => setActiveType(t.key)}>
              {t.uploadLabel}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Patient Profile (Admin/ASHA view, with trackable history) ───────────────
// ─── Patient History & Tracking — bilingual UI text ──────────────────────────
const HISTORY_UI_TEXT = {
  en: {
    title: "📈 Patient History & Tracking",
    addBtn: "➕ Add Checkup",
    records: "Records",
    empty: "No visit history recorded yet.",
    emptyAdmin: ' — click "Add Checkup" to record one.',
    edit: "✏️ Edit",
    delete: "🗑️ Delete",
    alert: "⚠️ Health Alert",
    precaution: "💡 Precaution",
    deleteTitle: "🗑️ Delete Checkup Record",
    deleteBody: "Are you sure you want to delete this checkup record? This action cannot be undone.",
    cancel: "Cancel",
    confirmDelete: "Delete Record",
  },
  hi: {
    title: "📈 रोगी इतिहास और ट्रैकिंग",
    addBtn: "➕ नई जांच जोड़ें",
    records: "रिकॉर्ड",
    empty: "अभी तक कोई विज़िट इतिहास दर्ज नहीं है।",
    emptyAdmin: ' — एक जोड़ने के लिए "नई जांच जोड़ें" पर क्लिक करें।',
    edit: "✏️ संपादित करें",
    delete: "🗑️ हटाएं",
    alert: "⚠️ स्वास्थ्य चेतावनी",
    precaution: "💡 सावधानी",
    deleteTitle: "🗑️ जांच रिकॉर्ड हटाएं",
    deleteBody: "क्या आप वाकई इस जांच रिकॉर्ड को हटाना चाहते हैं? यह क्रिया पूर्ववत नहीं की जा सकती।",
    cancel: "रद्द करें",
    confirmDelete: "रिकॉर्ड हटाएं",
  },
};

const VITAL_LABELS = {
  bp:          { en: "BP",     hi: "बीपी" },
  sugar:       { en: "Sugar",  hi: "शुगर" },
  weight:      { en: "Weight", hi: "वज़न" },
  temperature: { en: "Temp",   hi: "तापमान" },
  pulse:       { en: "Pulse",  hi: "पल्स" },
  spo2:        { en: "SpO2",   hi: "ऑक्सीजन" },
};

// Common ASHA / NHM visit categories, offered as a quick-pick in the form —
// admin can still freely edit the bilingual text after picking one.
const COMMON_VISIT_TYPES = [
  { en: "Registration Checkup",        hi: "पंजीकरण जांच" },
  { en: "Follow-up Checkup",           hi: "अनुवर्ती जांच" },
  { en: "Routine Checkup",             hi: "नियमित जांच" },
  { en: "Antenatal Checkup (ANC)",     hi: "प्रसवपूर्व जांच (ANC)" },
  { en: "Postnatal Checkup (PNC)",     hi: "प्रसवोत्तर जांच (PNC)" },
  { en: "Immunization Visit",          hi: "टीकाकरण विज़िट" },
  { en: "Disease Screening",           hi: "रोग जांच" },
  { en: "BP Monitoring",               hi: "रक्तचाप निगरानी" },
  { en: "Diabetes Screening",          hi: "मधुमेह जांच" },
  { en: "Home Visit",                  hi: "गृह भ्रमण" },
];

const BLANK_HISTORY_FORM = {
  date: new Date().toISOString().slice(0, 10),
  worker: "",
  typeEn: "", typeHi: "",
  noteEn: "", noteHi: "",
  alertEn: "", alertHi: "",
  precautionEn: "", precautionHi: "",
  bp: "", sugar: "", weight: "", temperature: "", pulse: "", spo2: "",
};

function recordToForm(r) {
  return {
    date: r.date || new Date().toISOString().slice(0, 10),
    worker: r.worker || "",
    typeEn: r.type?.en || "", typeHi: r.type?.hi || "",
    noteEn: r.note?.en || "", noteHi: r.note?.hi || "",
    alertEn: r.healthAlert?.en || "", alertHi: r.healthAlert?.hi || "",
    precautionEn: r.precaution?.en || "", precautionHi: r.precaution?.hi || "",
    bp: r.bp || "", sugar: r.sugar || "", weight: r.weight || "",
    temperature: r.temperature || "", pulse: r.pulse || "", spo2: r.spo2 || "",
  };
}

function formToHistoryRecord(form, existingId) {
  return {
    id: existingId || `h-${Date.now()}`,
    date: form.date,
    worker: form.worker.trim(),
    type: { en: form.typeEn.trim(), hi: form.typeHi.trim() },
    note: { en: form.noteEn.trim(), hi: form.noteHi.trim() },
    healthAlert: { en: form.alertEn.trim(), hi: form.alertHi.trim() },
    precaution: { en: form.precautionEn.trim(), hi: form.precautionHi.trim() },
    bp: form.bp.trim(), sugar: form.sugar.trim(), weight: form.weight.trim(),
    temperature: form.temperature.trim(), pulse: form.pulse.trim(), spo2: form.spo2.trim(),
  };
}

// ─── Add / Edit Checkup form modal (admin / ASHA worker only) ────────────────
function HistoryFormModal({ mode, initial, onCancel, onSubmit }) {
  const [form, setForm] = useState(() => (initial ? recordToForm(initial) : BLANK_HISTORY_FORM));
  const [formLang, setFormLang] = useState("en");
  const [error, setError] = useState("");

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const applyPreset = (e) => {
    const preset = COMMON_VISIT_TYPES.find((t) => t.en === e.target.value);
    if (preset) setForm((f) => ({ ...f, typeEn: preset.en, typeHi: preset.hi }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.date || !form.worker.trim()) {
      setError("Date and Doctor / ASHA Name are required.");
      return;
    }
    if (!form.typeEn.trim() || !form.noteEn.trim()) {
      setError("Visit Type and Reason / Notes (English) are required.");
      return;
    }
    setError("");
    onSubmit(formToHistoryRecord(form, initial?.id));
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {mode === "edit" ? "✏️ Edit Checkup Record" : "➕ Add New Checkup Record"}
          </div>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="form-error-banner">⚠️ {error}</div>}

            <div className="form-grid mb-4">
              <div className="form-group">
                <label className="form-label">Date<span className="required">*</span></label>
                <input
                  className="form-input"
                  type="date"
                  value={form.date}
                  onChange={(e) => set("date", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Doctor / ASHA Name<span className="required">*</span></label>
                <input
                  className="form-input"
                  value={form.worker}
                  onChange={(e) => set("worker", e.target.value)}
                  placeholder="e.g. Asha Devi (ASHA Worker) or Dr. Sunita Rao"
                />
              </div>
            </div>

            <div className="form-group mb-4">
              <label className="form-label">Quick Pick Visit Type (optional)</label>
              <select className="form-select" defaultValue="" onChange={applyPreset}>
                <option value="">— Select a common visit type —</option>
                {COMMON_VISIT_TYPES.map((t) => (
                  <option key={t.en} value={t.en}>{t.en}</option>
                ))}
              </select>
            </div>

            <div className="form-section-title">📝 Visit Details</div>

            <div className="btn-tabs lang-toggle-row">
              <button type="button" className={`btn-tab ${formLang === "en" ? "active" : ""}`} onClick={() => setFormLang("en")}>
                English
              </button>
              <button type="button" className={`btn-tab ${formLang === "hi" ? "active" : ""}`} onClick={() => setFormLang("hi")}>
                हिंदी
              </button>
            </div>

            {formLang === "en" ? (
              <>
                <div className="form-group mb-4">
                  <label className="form-label">Visit Type (English)<span className="required">*</span></label>
                  <input
                    className="form-input"
                    value={form.typeEn}
                    onChange={(e) => set("typeEn", e.target.value)}
                    placeholder="e.g. Follow-up Checkup"
                  />
                </div>
                <div className="form-group mb-4">
                  <label className="form-label">Reason / Clinical Notes (English)<span className="required">*</span></label>
                  <textarea
                    className="form-textarea"
                    value={form.noteEn}
                    onChange={(e) => set("noteEn", e.target.value)}
                    placeholder="Reason for visit and observations"
                  />
                </div>
                <div className="form-group mb-4">
                  <label className="form-label">Health Alert (English, optional)</label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: 56 }}
                    value={form.alertEn}
                    onChange={(e) => set("alertEn", e.target.value)}
                    placeholder="Anything that needs urgent attention"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Precaution / Advice (English, optional)</label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: 56 }}
                    value={form.precautionEn}
                    onChange={(e) => set("precautionEn", e.target.value)}
                    placeholder="Advice given to the patient"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="form-group mb-4">
                  <label className="form-label">विज़िट प्रकार (हिंदी)</label>
                  <input
                    className="form-input"
                    value={form.typeHi}
                    onChange={(e) => set("typeHi", e.target.value)}
                    placeholder="जैसे अनुवर्ती जांच"
                  />
                </div>
                <div className="form-group mb-4">
                  <label className="form-label">कारण / टिप्पणी (हिंदी)</label>
                  <textarea
                    className="form-textarea"
                    value={form.noteHi}
                    onChange={(e) => set("noteHi", e.target.value)}
                    placeholder="विज़िट का कारण और अवलोकन"
                  />
                </div>
                <div className="form-group mb-4">
                  <label className="form-label">स्वास्थ्य चेतावनी (हिंदी, वैकल्पिक)</label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: 56 }}
                    value={form.alertHi}
                    onChange={(e) => set("alertHi", e.target.value)}
                    placeholder="तुरंत ध्यान देने योग्य कोई बात"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">सावधानी / सलाह (हिंदी, वैकल्पिक)</label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: 56 }}
                    value={form.precautionHi}
                    onChange={(e) => set("precautionHi", e.target.value)}
                    placeholder="रोगी को दी गई सलाह"
                  />
                </div>
              </>
            )}

            <div className="form-section-title mt-4">🩺 Vitals</div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Blood Pressure</label>
                <input className="form-input" value={form.bp} onChange={(e) => set("bp", e.target.value)} placeholder="e.g. 120/80" />
              </div>
              <div className="form-group">
                <label className="form-label">Blood Sugar</label>
                <input className="form-input" value={form.sugar} onChange={(e) => set("sugar", e.target.value)} placeholder="e.g. 110 mg/dL" />
              </div>
              <div className="form-group">
                <label className="form-label">Weight</label>
                <input className="form-input" value={form.weight} onChange={(e) => set("weight", e.target.value)} placeholder="e.g. 60 kg" />
              </div>
              <div className="form-group">
                <label className="form-label">Temperature</label>
                <input className="form-input" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} placeholder="e.g. 98.6°F" />
              </div>
              <div className="form-group">
                <label className="form-label">Pulse Rate</label>
                <input className="form-input" value={form.pulse} onChange={(e) => set("pulse", e.target.value)} placeholder="e.g. 76 bpm" />
              </div>
              <div className="form-group">
                <label className="form-label">SpO2</label>
                <input className="form-input" value={form.spo2} onChange={(e) => set("spo2", e.target.value)} placeholder="e.g. 98%" />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline-purple" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-gold">
              {mode === "edit" ? "Update Record" : "Save Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Patient History & Tracking card ─────────────────────────────────────────
// Reused by the admin/ASHA "Patient Profile" view (full CRUD) and the
// patient's own "Health Records" page (read-only). `records` is the flat
// array for ONE patient; CRUD writes go through `setHistory`, which holds
// the full { [patientId]: records[] } map lifted at the App level so admin
// edits are immediately reflected in the patient's own view.
function PatientHistoryCard({ patientId, records, setHistory, isAdmin, toast }) {
  const [lang, setLang] = useState("en");
  const [formModal, setFormModal] = useState(null); // { mode: 'add' | 'edit', record } | null
  const [deleteTarget, setDeleteTarget] = useState(null);

  const T = HISTORY_UI_TEXT[lang];
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1));

  const openAddForm  = () => setFormModal({ mode: "add", record: null });
  const openEditForm = (record) => setFormModal({ mode: "edit", record });
  const closeForm    = () => setFormModal(null);

  const upsertHistory = (patientId, updater) =>
    setHistory((prev) => ({ ...prev, [patientId]: updater(prev[patientId] || []) }));

  const handleFormSubmit = (record) => {
    if (formModal.mode === "edit") {
      upsertHistory(patientId, (list) => list.map((r) => (r.id === record.id ? record : r)));
      toast?.("Checkup record updated!", "success", record.type.en);
    } else {
      upsertHistory(patientId, (list) => [record, ...list]);
      toast?.("Checkup record added!", "success", record.type.en);
    }
    setFormModal(null);
  };

  const requestDelete = (record) => setDeleteTarget(record);
  const cancelDelete  = () => setDeleteTarget(null);
  const confirmDeleteRecord = () => {
    upsertHistory(patientId, (list) => list.filter((r) => r.id !== deleteTarget.id));
    toast?.("Checkup record deleted", "success", deleteTarget.type.en);
    setDeleteTarget(null);
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="card-title">{T.title}</div>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <div className="btn-tabs btn-tabs-compact" title="Switch language / भाषा बदलें">
            <button type="button" className={`btn-tab ${lang === "en" ? "active" : ""}`} onClick={() => setLang("en")}>EN</button>
            <button type="button" className={`btn-tab ${lang === "hi" ? "active" : ""}`} onClick={() => setLang("hi")}>हिं</button>
          </div>
          <span className="badge badge-gold">{records.length} {T.records}</span>
          {isAdmin && (
            <button className="btn btn-gold btn-sm" onClick={openAddForm}>{T.addBtn}</button>
          )}
        </div>
      </div>

      <div className="card-body">
        {sorted.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)" }}>
            {T.empty}{isAdmin ? T.emptyAdmin : ""}
          </div>
        ) : (
          sorted.map((r) => (
            <div className="history-item" key={r.id}>
              <div className="history-item-icon">🩺</div>
              <div className="history-item-body">
                <div className="history-item-top">
                  <div>
                    <div className="history-item-title">{r.type?.[lang] || r.type?.en}</div>
                    <div className="history-item-meta">{r.worker} · {r.date}</div>
                  </div>
                  {isAdmin && (
                    <div className="history-item-actions">
                      <button className="btn btn-outline-purple btn-sm" onClick={() => openEditForm(r)}>{T.edit}</button>
                      <button className="btn btn-danger btn-sm" onClick={() => requestDelete(r)}>{T.delete}</button>
                    </div>
                  )}
                </div>

                {(r.note?.[lang] || r.note?.en) && (
                  <div className="history-item-note">{r.note[lang] || r.note.en}</div>
                )}

                {(r.healthAlert?.[lang] || r.healthAlert?.en) && (
                  <div className="health-alert-banner">{T.alert}: {r.healthAlert[lang] || r.healthAlert.en}</div>
                )}
                {(r.precaution?.[lang] || r.precaution?.en) && (
                  <div className="precaution-banner">{T.precaution}: {r.precaution[lang] || r.precaution.en}</div>
                )}

                <div className="flex gap-2" style={{ flexWrap: "wrap", marginTop: 8 }}>
                  {r.bp && <span className="badge badge-purple">{VITAL_LABELS.bp[lang]} {r.bp}</span>}
                  {r.sugar && r.sugar !== "—" && <span className="badge badge-gold">{VITAL_LABELS.sugar[lang]} {r.sugar}</span>}
                  {r.weight && <span className="badge badge-green">{VITAL_LABELS.weight[lang]} {r.weight}</span>}
                  {r.temperature && <span className="badge badge-blue">{VITAL_LABELS.temperature[lang]} {r.temperature}</span>}
                  {r.pulse && <span className="badge badge-purple">{VITAL_LABELS.pulse[lang]} {r.pulse}</span>}
                  {r.spo2 && <span className="badge badge-teal">{VITAL_LABELS.spo2[lang]} {r.spo2}</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add / Edit checkup modal — admin / ASHA worker only */}
      {formModal && (
        <HistoryFormModal
          mode={formModal.mode}
          initial={formModal.record}
          onCancel={closeForm}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Delete confirmation modal — admin / ASHA worker only */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{T.deleteTitle}</div>
              <button className="modal-close" onClick={cancelDelete}>✕</button>
            </div>
            <div className="modal-body">{T.deleteBody}</div>
            <div className="modal-footer">
              <button className="btn btn-outline-purple" onClick={cancelDelete}>{T.cancel}</button>
              <button className="btn btn-danger" onClick={confirmDeleteRecord}>{T.confirmDelete}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ASHA location helpers ────────────────────────────────────────────────────
// ASHA workers can be assigned one, several, or ALL locations. Older accounts
// only ever had a single `location` string — these helpers normalize both
// shapes so the rest of the app can treat every worker the same way.
const ALL_LOCATIONS = "ALL";

function getAshaLocations(worker) {
  if (!worker) return [];
  if (Array.isArray(worker.locations) && worker.locations.length) return worker.locations;
  if (worker.location) return [worker.location];
  return [];
}

function ashaHasAllAccess(worker) {
  return getAshaLocations(worker).includes(ALL_LOCATIONS);
}

// Does this ASHA worker have access to patients registered under `village`?
function ashaCanAccessVillage(worker, village) {
  const locs = getAshaLocations(worker);
  if (locs.includes(ALL_LOCATIONS)) return true;
  const v = (village || "").trim().toLowerCase();
  return locs.some((l) => l.trim().toLowerCase() === v);
}

// Short human-readable summary, e.g. "Noida, Ghaziabad +2 more" or "All Locations".
function formatLocationsLabel(worker, { max = 2 } = {}) {
  const locs = getAshaLocations(worker);
  if (!locs.length) return "No location set";
  if (locs.includes(ALL_LOCATIONS)) return "All Locations";
  if (locs.length <= max) return locs.join(", ");
  return `${locs.slice(0, max).join(", ")} +${locs.length - max} more`;
}

// ─── ASHA Worker form helpers ────────────────────────────────────────────────
const BLANK_ASHA_FORM = { name: "", email: "", password: "", mobile: "", locations: [], allLocations: false };

function ashaToForm(worker) {
  const locs = getAshaLocations(worker);
  const allLocations = locs.includes(ALL_LOCATIONS);
  return {
    name: worker.name || "",
    email: worker.email || "",
    password: worker.password || "",
    mobile: worker.mobile || "",
    locations: allLocations ? [] : locs,
    allLocations,
  };
}

function formToAsha(form, existingId, existingRegistered) {
  const locations = form.allLocations
    ? [ALL_LOCATIONS]
    : Array.from(new Set(form.locations.map((l) => l.trim()).filter(Boolean)));
  return {
    id: existingId || `ASHA-${Date.now()}`,
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password.trim(),
    mobile: form.mobile.trim(),
    locations,
    // Legacy single-location field, kept in sync for any old code/queries
    // that still read `location` directly. Left blank for "all locations".
    location: locations.includes(ALL_LOCATIONS) ? "" : (locations[0] || ""),
    registered: existingRegistered || new Date().toISOString().slice(0, 10),
  };
}

// ─── Add / Edit ASHA Worker modal (Admin only) ───────────────────────────────
function AshaFormModal({ mode, initial, existingWorkers, locationSuggestions, onCancel, onSubmit }) {
  const suggestions = locationSuggestions || [];
  const [form, setForm]       = useState(() => (initial ? ashaToForm(initial) : BLANK_ASHA_FORM));
  const [error, setError]     = useState("");
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [locationInput, setLocationInput] = useState("");

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const addLocation = (raw) => {
    const val = raw.trim();
    if (!val) return;
    setForm((f) =>
      f.locations.some((l) => l.toLowerCase() === val.toLowerCase())
        ? f
        : { ...f, locations: [...f.locations, val] }
    );
    setLocationInput("");
  };
  const removeLocation = (val) =>
    setForm((f) => ({ ...f, locations: f.locations.filter((l) => l !== val) }));
  const handleLocationKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addLocation(locationInput);
    } else if (e.key === "Backspace" && !locationInput && form.locations.length) {
      removeLocation(form.locations[form.locations.length - 1]);
    }
  };
  const toggleAllLocations = (checked) =>
    setForm((f) => ({ ...f, allLocations: checked, locations: checked ? [] : f.locations }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const passwordRequired = mode !== "edit"; // editing doesn't change the login password
    const hasLocation = form.allLocations || form.locations.length > 0;
    if (!form.name.trim() || !form.email.trim() || (passwordRequired && !form.password.trim()) || !form.mobile.trim() || !hasLocation) {
      setError("Name, email, password, mobile and at least one location are all required.");
      return;
    }
    const emailLower = form.email.trim().toLowerCase();
    const clash = existingWorkers.some(
      (w) => w.email.toLowerCase() === emailLower && w.id !== initial?.id
    );
    if (clash) {
      setError("Another ASHA worker already uses this email.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      // onSubmit (in ManageAsha) actually hits the backend — awaiting here
      // keeps the modal open with an error message if that call fails,
      // instead of closing and silently losing the account.
      await onSubmit(formToAsha(form, initial?.id, initial?.registered), mode);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {mode === "edit" ? "✏️ Edit ASHA Worker" : "➕ Add New ASHA Worker"}
          </div>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="form-error-banner">⚠️ {error}</div>}

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Full Name<span className="required">*</span></label>
                <input
                  className="form-input"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Sunita Devi"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Mobile Number<span className="required">*</span></label>
                <input
                  className="form-input"
                  type="tel"
                  value={form.mobile}
                  onChange={(e) => set("mobile", e.target.value)}
                  placeholder="10-digit number"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email (used to login)<span className="required">*</span></label>
                <input
                  className="form-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="worker@ashacare.in"
                />
              </div>
              {mode !== "edit" && (
                <div className="form-group">
                  <label className="form-label">Password<span className="required">*</span></label>
                  <div style={{ position: "relative" }}>
                    <input
                      className="form-input has-action"
                      type={showPass ? "text" : "password"}
                      value={form.password}
                      onChange={(e) => set("password", e.target.value)}
                      placeholder="Set a login password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((p) => !p)}
                      style={{
                        position: "absolute", right: 12, top: "50%",
                        transform: "translateY(-50%)", background: "none",
                      border: "none", cursor: "pointer", fontSize: 15,
                      color: "rgba(109,40,217,0.5)",
                    }}
                    >
                      {showPass ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>
              )}
              <div className="form-group full">
                <label className="form-label">Assigned Location(s)<span className="required">*</span></label>

                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={form.allLocations}
                    onChange={(e) => toggleAllLocations(e.target.checked)}
                  />
                  🌐 Give access to <strong>&nbsp;all locations&nbsp;</strong> (every patient, any village)
                </label>

                {!form.allLocations && (
                  <>
                    <div
                      style={{
                        display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
                        border: "1px solid rgba(109,40,217,0.25)", borderRadius: 10, padding: "8px 10px",
                        minHeight: 44,
                      }}
                    >
                      {form.locations.map((loc) => (
                        <span
                          key={loc}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            background: "rgba(109,40,217,0.12)", color: "var(--text-dark)",
                            borderRadius: 999, padding: "4px 10px", fontSize: 12.5, fontWeight: 600,
                          }}
                        >
                          📍 {loc}
                          <button
                            type="button"
                            onClick={() => removeLocation(loc)}
                            aria-label={`Remove ${loc}`}
                            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "rgba(109,40,217,0.7)", lineHeight: 1 }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      <input
                        className="form-input"
                        list="asha-location-suggestions"
                        value={locationInput}
                        onChange={(e) => setLocationInput(e.target.value)}
                        onKeyDown={handleLocationKeyDown}
                        onBlur={() => locationInput.trim() && addLocation(locationInput)}
                        placeholder={form.locations.length ? "Add another…" : "e.g. Noida"}
                        style={{ flex: 1, minWidth: 120, border: "none", outline: "none", padding: "4px 2px" }}
                      />
                    </div>
                    <datalist id="asha-location-suggestions">
                      {suggestions
                        .filter((s) => !form.locations.some((l) => l.toLowerCase() === s.toLowerCase()))
                        .map((s) => (
                          <option key={s} value={s} />
                        ))}
                    </datalist>
                  </>
                )}

                <span className="textarea-hint">
                  {form.allLocations
                    ? "This ASHA worker will see and manage patients from every location."
                    : "Type a village/city and press Enter (or comma) to add it — add as many as needed. This worker will only see patients registered under the selected location(s)."}
                </span>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline-purple" onClick={onCancel} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-gold" disabled={saving}>
              {saving ? "Saving…" : mode === "edit" ? "Update ASHA Worker" : "Add ASHA Worker"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Manage ASHA Dashboard (Admin only) ──────────────────────────────────────
// Admin adds ASHA workers tied to a location (e.g. Noida, Ghaziabad). Each
// worker then logs in with role "asha" and gets the same dashboard/capabilities
// as Admin, except this page — only the one Admin account can manage ASHA.
function ManageAsha({ ashaWorkers, setAshaWorkers, patients, toast, onBack, canEdit }) {
  const [formModal, setFormModal]     = useState(null); // { mode: 'add' | 'edit', worker } | null
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [q, setQ] = useState("");

  const openAddForm  = () => setFormModal({ mode: "add", worker: null });
  const openEditForm = (worker) => setFormModal({ mode: "edit", worker });
  const closeForm    = () => setFormModal(null);

  const handleFormSubmit = async (worker, mode) => {
    if (mode === "edit") {
      const uid = formModal.worker?.uid;
      if (!uid) {
        toast?.("Can't update this worker", "error", "Missing account ID — try reopening the edit form.");
        return;
      }
      await updateAshaWorker(uid, {
        name:      worker.name,
        mobile:    worker.mobile,
        location:  worker.location,
        locations: worker.locations,
        email:     worker.email,
      });
      // No manual setAshaWorkers push — the onSnapshot listener on `users`
      // in App will reflect the update automatically.
      toast?.("ASHA worker updated successfully!", "success", `${worker.name} • ${formatLocationsLabel(worker, { max: 3 })}`);
    } else {
      // This is the real fix: actually create the Firebase Auth user +
      // Firestore `users` doc via the backend, instead of only touching
      // local React state. The onSnapshot listener on `users` (role=="asha")
      // in App will pick up the new doc automatically, so we don't need to
      // (and shouldn't) manually push `worker` into ashaWorkers here.
      await createUser({
        email:     worker.email,
        password:  worker.password,
        name:      worker.name,
        role:      "asha",
        mobile:    worker.mobile,
        location:  worker.location,
        locations: worker.locations,
      });
      toast?.("ASHA worker added successfully!", "success", `${worker.name} • ${formatLocationsLabel(worker, { max: 3 })}`);
    }
    setFormModal(null);
  };

  const requestDelete = (worker) => setDeleteTarget(worker);
  const cancelDelete  = () => setDeleteTarget(null);
  const confirmDeleteWorker = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      // Actually revoke the Firebase Auth account + Firestore doc.
      // Falls back to local-only removal if this worker predates the fix
      // and has no `uid` (e.g. leftover mock/local entries).
      if (target.uid) {
        await deleteAuthUser(target.uid);
      }
      setAshaWorkers((prev) => prev.filter((w) => w.id !== target.id));
      toast?.("ASHA worker removed", "success", `${target.name} (${formatLocationsLabel(target, { max: 3 })})`);
    } catch (err) {
      toast?.("Failed to remove ASHA worker", "error", err.message || "Please try again.");
    }
  };

  const patientsFor = (worker) => {
    if (ashaHasAllAccess(worker)) return patients.length;
    const locs = getAshaLocations(worker).map((l) => l.trim().toLowerCase());
    return patients.filter((p) => locs.includes((p.village || "").trim().toLowerCase())).length;
  };

  // Suggestions for the location tag input — every distinct village already
  // in use, either from existing patients or other ASHA workers' assignments.
  const locationSuggestions = Array.from(
    new Set([
      ...patients.map((p) => (p.village || "").trim()).filter(Boolean),
      ...ashaWorkers.flatMap((w) => getAshaLocations(w).filter((l) => l !== ALL_LOCATIONS)).map((l) => l.trim()),
    ])
  ).sort((a, b) => a.localeCompare(b));

  const query = q.trim().toLowerCase();
  const filtered = query
    ? ashaWorkers.filter(
        (w) =>
          w.name.toLowerCase().includes(query) ||
          getAshaLocations(w).some((l) => l.toLowerCase().includes(query))
      )
    : ashaWorkers;

  const locationsCovered = new Set(
    ashaWorkers.flatMap((w) => getAshaLocations(w).filter((l) => l !== ALL_LOCATIONS).map((l) => l.trim().toLowerCase()))
  ).size;

  return (
    <div className="page-body">
      {/* Back / Add actions */}
      <div className="flex items-center gap-3 mb-4" style={{ justifyContent: "space-between" }}>
        <button className="btn btn-outline-purple btn-sm" onClick={onBack}>← Back to Dashboard</button>
        <button className="btn btn-gold btn-sm" onClick={openAddForm}>➕ Add ASHA Worker</button>
      </div>

      {/* Stat Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">⚕️</div>
          <div className="stat-label">Total ASHA Workers</div>
          <div className="stat-value">{ashaWorkers.length}</div>
        </div>
        <div className="stat-card blue">
          <div className="stat-icon">📍</div>
          <div className="stat-label">Locations Covered</div>
          <div className="stat-value">{locationsCovered}</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon">👥</div>
          <div className="stat-label">Total Patients</div>
          <div className="stat-value">{patients.length}</div>
        </div>
      </div>

      {/* ASHA Workers Card */}
      <div className="card card-ai">
        <div className="card-header">
          <div className="card-title">
            <span className="card-title-hi">आशा कार्यकर्ता प्रबंधन</span>
          </div>
        </div>
        <div className="card-body">
          <div className="search-bar">
            <div className="search-input-wrapper">
              <input
                className="search-input"
                type="text"
                autoComplete="off"
                placeholder="🔍  Search ASHA workers by name or location…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ASHA Worker</th>
                  <th>ID</th>
                  <th>Location</th>
                  <th>Contact</th>
                  <th>Patients in Area</th>
                  <th>Added On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)" }}>
                      {ashaWorkers.length === 0
                        ? 'No ASHA workers added yet — click "Add ASHA Worker" to create one.'
                        : "No ASHA workers found"}
                    </td>
                  </tr>
                ) : (
                  filtered.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <div className="patient-cell">
                          <div className="patient-avatar">{w.name[0]}</div>
                          <div>
                            <div className="patient-name">{w.name}</div>
                            <div className="patient-id">{w.email}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className="badge badge-purple">{w.id}</span></td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 220 }}>
                          {ashaHasAllAccess(w) ? (
                            <span className="badge badge-blue">🌐 All Locations</span>
                          ) : (
                            getAshaLocations(w).map((l) => (
                              <span key={l} className="badge badge-blue">📍 {l}</span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="text-sm">{w.mobile}</td>
                      <td><span className="badge badge-green">{patientsFor(w)} patients</span></td>
                      <td className="text-xs text-muted">{w.registered}</td>
                      <td>
                        <div className="flex gap-2">
                          {canEdit && (
                            <button className="btn btn-outline-purple btn-sm" onClick={() => openEditForm(w)}>Edit</button>
                          )}
                          <button className="btn btn-danger btn-sm" onClick={() => requestDelete(w)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add / Edit ASHA worker modal */}
      {formModal && (
        <AshaFormModal
          mode={formModal.mode}
          initial={formModal.worker}
          existingWorkers={ashaWorkers}
          locationSuggestions={locationSuggestions}
          onCancel={closeForm}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">🗑️ Remove ASHA Worker</div>
              <button className="modal-close" onClick={cancelDelete}>✕</button>
            </div>
            <div className="modal-body">
              Are you sure you want to remove <strong>{deleteTarget.name}</strong> ({formatLocationsLabel(deleteTarget, { max: 3 })})?
              They will no longer be able to log in, and {getAshaLocations(deleteTarget).length > 1 ? "these locations" : "this location"} will need a new ASHA worker assigned.
              This action cannot be undone.
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline-purple" onClick={cancelDelete}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDeleteWorker}>Remove Worker</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page Title Map ───────────────────────────────────────────────────────────
const PAGE_TITLES = {
  reminder:  "Reminder",
  calendar:  "Calendar Note",
  chatbot:   "AI Assistant",
  medical:   "Medical Analysis",
  profile:   "My Profile",
  records:   "Health Records",
  schemes:   "Govt Scheme Suggestions",
  "patient-profile": "Patient Profile",
  "edit-patient":    "Edit Patient",
  "manage-asha":     "Manage ASHA Workers",
  "manage-admin":    "Manage Admin Profile",
};

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user,          setUser]          = useState(null);
  const [page,          setPage]          = useState("reminder");
  const [patients,      setPatients]      = useState([]);
  const [ashaWorkers,   setAshaWorkers]   = useState([]);
  const [schemes,       setSchemes]       = useState(GOVT_SCHEMES); // real scheme data — shown until Firestore has its own docs
  const [history,       setHistory]       = useState({});
  const [mobileMenu,    setMobile]        = useState(false);
  const [collapsed,     setCollapsed]     = useState(false);
  const [authLoading,   setAuthLoading]   = useState(true); // prevents flash of login page
  const { toasts, add: toast, dismiss }  = useToast();

  // Tracks when a manual login is in progress so onAuthStateChanged doesn't
  // race ahead and set the user before the role check in handleSubmit runs.
  const isManualLoginRef = useRef(false);

  // ── Restore session on page refresh ────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // A manual login (handleSubmit) is in progress — it will call onLogin
        // itself after the role check. Don't touch user state here.
        if (isManualLoginRef.current) {
          setAuthLoading(false);
          return;
        }
        try {
          await firebaseUser.getIdToken(true); // refresh so role claim is present
          const snap = await getDoc(doc(db, "users", firebaseUser.uid));
          if (snap.exists()) {
            const profile = snap.data();
            setUser(profile);
            setPage(profile.role === "patient" ? "profile" : "reminder");
          }
        } catch (err) {
          console.error("Session restore failed:", err);
        }
      }
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  // ── Real-time patients from Firestore ───────────────────────────────────────
  // ASHA workers only ever see patients in their own village (see
  // `visiblePatients` below), so for them we filter server-side too —
  // downloading the entire patients collection just to throw most of it
  // away client-side was the main thing making data load slowly right
  // after an ASHA worker signed in. Sorting is done client-side here to
  // avoid requiring a new Firestore composite index (village + registered).
  useEffect(() => {
    if (!user) return;
    const isAsha        = user.role === "asha";
    const hasAllAccess  = isAsha && ashaHasAllAccess(user);
    const ashaLocations = isAsha ? getAshaLocations(user) : [];
    // Firestore's `in` operator only supports up to 10 values — for workers
    // assigned more locations than that we fall back to fetching everything
    // and filtering client-side below (rare case, but keeps things working).
    const useServerFilter = isAsha && !hasAllAccess && ashaLocations.length > 0 && ashaLocations.length <= 10;

    const q = useServerFilter
      ? query(collection(db, "patients"), where("village", "in", ashaLocations))
      : query(collection(db, "patients"), orderBy("registered", "desc"));

    return onSnapshot(q, (snap) => {
      let docs = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      if (isAsha && !hasAllAccess) {
        const locSet = new Set(ashaLocations.map((l) => l.trim().toLowerCase()));
        docs = docs.filter((p) => locSet.has((p.village || "").trim().toLowerCase()));
      }
      if (useServerFilter) docs.sort((a, b) => (b.registered || "").localeCompare(a.registered || ""));
      setPatients(docs);
    });
  }, [user]);

  // ── Real-time government schemes from Firestore ─────────────────────────────
  // Falls back to the built-in GOVT_SCHEMES until the "govt_schemes" collection
  // actually has documents in it — see seedGovtSchemes.js to push them in.
  useEffect(() => {
    if (!user) return;
    return onSnapshot(collection(db, "govt_schemes"), (snap) => {
      if (!snap.empty) {
        setSchemes(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      }
    });
  }, [user]);

  // ── Real-time ASHA workers list (admin/super_admin only) ────────────────────
  useEffect(() => {
    if (!user) return;
    if (user.role !== "admin" && user.role !== "super_admin") return;
    const q = query(collection(db, "users"), where("role", "==", "asha"));
    return onSnapshot(q, (snap) =>
      setAshaWorkers(snap.docs.map((d) => d.data()))
    );
  }, [user]);

  // ── Auth helpers ────────────────────────────────────────────────────────────
  const login = (profile) => {
    isManualLoginRef.current = false;
    setUser(profile);
    setPage(profile.role === "patient" ? "profile" : "reminder");
  };

  const logout = async () => {
    await signOut(auth);
    setUser(null);
    setPatients([]);
    setSchemes([]);
    setAshaWorkers([]);
    setHistory({});
    setPage("reminder");
    setCollapsed(false);
  };

  // ── Navigation ──────────────────────────────────────────────────────────────
  const handleNav = (key) => { setPage(key); setMobile(false); };

  // ── Loading state (prevents flash of login screen on refresh) ───────────────
  if (authLoading) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100vh", background: "var(--bg, #0f0f1a)", color: "#a78bfa",
        fontSize: "1.1rem", fontFamily: "sans-serif",
      }}>
        Loading HealthGPT…
      </div>
    );
  }

  // ── Auth gate ───────────────────────────────────────────────────────────────
  if (!user) return (
    <>
      <AuthPage
        onLogin={login}
        onLoginStart={() => { isManualLoginRef.current = true; }}
        onLoginEnd={()  => { isManualLoginRef.current = false; }}
      />
      <Toast toasts={toasts} dismiss={dismiss} />
    </>
  );

  // ── ASHA workers only see patients in their assigned location(s) ───────────
  // (unless they've been granted "all locations" access)
  const visiblePatients = user.role === "asha"
    ? patients.filter((p) => ashaCanAccessVillage(user, p.village))
    : patients;

  // ── Page router ─────────────────────────────────────────────────────────────
  const renderPage = () => {
    const isStaff = user.role === "admin" || user.role === "super_admin" || user.role === "asha";

    if (isStaff) {
      if (page === "reminder") return <Reminder />;
      if (page === "calendar") return <CalendarNote />;
      if (page === "manage-admin" && user.role !== "asha") return (
        <ManageAdminProfile
          adminProfile={user}
          // NOTE: `user` (the Firestore login profile) has no `password` field —
          // Firebase Auth never exposes it client-side. The password-change and
          // security-question panels below still compare against
          // `adminProfile.password`, so they will always report "incorrect
          // password" until that logic is rewired to Firebase's
          // reauthenticateWithCredential()/updatePassword() flow. This setter
          // only keeps `name` edits working (and prevents a crash) for now.
          setAdminProfile={(updater) =>
            setUser((u) => (typeof updater === "function" ? updater(u) : updater))
          }
          toast={toast}
          onBack={() => setPage("reminder")}
          onLogout={logout}
          onNameSaved={(n) => setUser((u) => ({ ...u, name: n }))}
        />
      );
      if (page === "manage-asha" && user.role !== "asha") return (
        <ManageAsha
          ashaWorkers={ashaWorkers}
          setAshaWorkers={setAshaWorkers}
          patients={patients}
          toast={toast}
          onBack={() => setPage("reminder")}
          canEdit={user.role === "super_admin"}
        />
      );
      if (page === "chatbot")  return <ChatBot />;
      if (page === "medical")  return <MedicalAnalysis />;
      if (page === "schemes")  return (
        <GovtSchemes schemes={schemes} setSchemes={setSchemes} isAdmin toast={toast} />
      );
    } else {
      // Patient role
      if (page === "profile")  return <PatientDashboard user={user} />;
      if (page === "records")  return <HealthRecords user={user} history={history} setHistory={setHistory} />;
      if (page === "chatbot")  return <ChatBot />;
      if (page === "medical")  return <MedicalAnalysis />;
      if (page === "schemes")  return <GovtSchemes schemes={schemes} setSchemes={setSchemes} isAdmin={false} toast={toast} />;
    }
    return null;
  };

  return (
    <AuthContext.Provider value={{ user, logout }}>
      <div className="app-layout">
        <Sidebar
          user={user}
          active={page}
          onNav={handleNav}
          mobileOpen={mobileMenu}
          onOverlayClick={() => setMobile(false)}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((p) => !p)}
          patientCount={visiblePatients.length}
        />
        <div className={`main-content${collapsed ? " sidebar-collapsed-content" : ""}`}>
          <TopBar
            user={user}
            pageTitle={PAGE_TITLES[page] || "HealthGPT"}
            onLogout={logout}
            onMenuToggle={() => setMobile((p) => !p)}
            onNav={handleNav}
          />
          {renderPage()}
        </div>
      </div>

      <Toast toasts={toasts} dismiss={dismiss} />
    </AuthContext.Provider>
  );
}