import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ApiError, normalizeServerUrl, ServerApi } from "../lib/api";
import { useStore, type ServerAccount } from "../lib/store";
import { apiFor, signedIn, signOut } from "../lib/sync";
import { toast } from "../lib/ui";
import { Modal } from "./Modal";

/** Servers this device knows, sign-in, and account security for each. */
export function AccountModal({ onClose }: { onClose(): void }) {
  const servers = useStore((s) => s.servers);
  const [selected, setSelected] = useState<string | "new">(servers.find((s) => s.token)?.url ?? servers[0]?.url ?? "new");
  const account = servers.find((s) => s.url === selected);

  return (
    <Modal title="Servers & account" onClose={onClose}>
      <div className="envs">
        <div className="env-list">
          {servers.map((s) => (
            <button key={s.url} className={`btn ghost ${selected === s.url ? "primary" : ""}`} onClick={() => setSelected(s.url)} title={s.url}>
              {s.token ? "● " : "○ "}
              {new URL(s.url).host}
            </button>
          ))}
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setSelected("new")}>
            + Connect a server
          </button>
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            Server workspaces are shared with your team. Local workspaces stay on this device.
          </p>
        </div>
        <div>
          {selected === "new" || !account ? (
            <SignIn onDone={(url) => setSelected(url)} />
          ) : account.token && account.user ? (
            <AccountPanel account={account} />
          ) : (
            <SignIn initialUrl={account.url} initialEmail={account.user?.email} onDone={(url) => setSelected(url)} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : String(e);
}

function SignIn({ initialUrl = "http://localhost:8787", initialEmail = "", onDone }: { initialUrl?: string; initialEmail?: string; onDone(url: string): void }) {
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [url, setUrl] = useState(initialUrl);
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      const base = normalizeServerUrl(url);
      const api = new ServerApi(base);
      const health = await api.health().catch(() => undefined);
      if (health?.name !== "getman-server") throw new Error(`${base} does not look like a Getman server.`);

      if (mfaToken) {
        const res = await api.login2fa(mfaToken, code);
        await signedIn(base, res.token, res.user);
      } else if (mode === "register") {
        const res = await api.register({ email, password, name });
        await signedIn(base, res.token, res.user);
      } else {
        const res = await api.login(email, password);
        if ("mfaRequired" in res) {
          setMfaToken(res.mfaToken);
          return;
        }
        await signedIn(base, res.token, res.user);
      }
      toast("Signed in");
      onDone(base);
    });

  return (
    <form
      style={{ display: "grid", gap: 12, maxWidth: 420 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {mfaToken ? (
        <>
          <h4 style={{ margin: 0 }}>Two-factor authentication</h4>
          <p className="muted" style={{ margin: 0 }}>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          <input className="input mono" autoFocus autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
        </>
      ) : (
        <>
          <div className="row">
            <button type="button" className={`btn ${mode === "signin" ? "primary" : "ghost"}`} onClick={() => setMode("signin")}>Sign in</button>
            <button type="button" className={`btn ${mode === "register" ? "primary" : "ghost"}`} onClick={() => setMode("register")}>Create account</button>
          </div>
          <label>
            Server URL
            <input className="input mono" style={{ width: "100%" }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://getman.example.com" />
          </label>
          {mode === "register" && (
            <label>
              Name
              <input className="input" style={{ width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input className="input" style={{ width: "100%" }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label>
            Password
            <input
              className="input"
              style={{ width: "100%" }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
            {mode === "register" && <span className="muted" style={{ fontSize: 12 }}>At least 10 characters.</span>}
          </label>
        </>
      )}
      {error && <p className="hint warn" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? "Please wait…" : mfaToken ? "Verify" : mode === "register" ? "Create account" : "Sign in"}
        </button>
        {mfaToken && (
          <button type="button" className="btn ghost" onClick={() => (setMfaToken(undefined), setCode(""))}>
            Back
          </button>
        )}
      </div>
    </form>
  );
}

function AccountPanel({ account }: { account: ServerAccount }) {
  const user = account.user!;
  const api = apiFor(account.url);
  const removeServer = useStore((s) => s.removeServer);

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <strong>{user.name}</strong> <span className="muted">· {user.email}</span>
          <div className="muted mono" style={{ fontSize: 12 }}>{account.url}</div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => void signOut(account.url).then(() => toast("Signed out"))}>Sign out</button>
        <button
          className="btn danger"
          title="Sign out and forget this server"
          onClick={() => confirm(`Forget ${account.url}? Its workspaces are removed from this device.`) && void signOut(account.url).then(() => removeServer(account.url))}
        >
          Forget
        </button>
      </div>
      <TwoFactor api={api} account={account} />
      <Sessions api={api} />
      <ChangePassword api={api} />
    </div>
  );
}

function TwoFactor({ api, account }: { api: ServerApi; account: ServerAccount }) {
  const upsertServer = useStore((s) => s.upsertServer);
  const enabled = account.user!.totpEnabled;
  const [setup, setSetup] = useState<{ secret: string; qr: string }>();
  const [codes, setCodes] = useState<string[]>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [remaining, setRemaining] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.me().then((r) => setRemaining(r.recoveryCodesRemaining), () => {});
  }, [api.url, enabled]);

  const setUser = (totpEnabled: boolean) => upsertServer({ ...account, user: { ...account.user!, totpEnabled } });
  const attempt = (fn: () => Promise<void>) => fn().then(() => setError(undefined), (e) => setError(errorText(e)));

  return (
    <div className="section">
      <h4>Two-factor authentication {enabled ? <span style={{ color: "var(--success)" }}>· on</span> : <span className="muted">· off</span>}</h4>

      {codes && (
        <div className="hint" style={{ marginBottom: 12 }}>
          <strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They will not be shown again.
          <pre className="code" style={{ marginTop: 8, minHeight: 0 }}>{codes.join("\n")}</pre>
          <button className="btn" onClick={() => navigator.clipboard.writeText(codes.join("\n")).then(() => toast("Copied"))}>Copy</button>{" "}
          <button className="btn" onClick={() => setCodes(undefined)}>I saved them</button>
        </div>
      )}

      {!enabled && !setup && (
        <button
          className="btn primary"
          onClick={() =>
            attempt(async () => {
              const s = await api.setup2fa();
              setSetup({ secret: s.secret, qr: await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 180 }) });
            })
          }
        >
          Turn on 2FA
        </button>
      )}

      {!enabled && setup && (
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <img src={setup.qr} width={180} height={180} alt="QR code for your authenticator app" style={{ borderRadius: 8, background: "#fff" }} />
          <div style={{ display: "grid", gap: 8 }}>
            <span>1. Scan with Google Authenticator, 1Password, Authy, Microsoft Authenticator…</span>
            <span className="muted" style={{ fontSize: 12 }}>
              Can't scan? Enter this key: <code style={{ userSelect: "all" }}>{setup.secret}</code>
            </span>
            <span>2. Enter the 6-digit code it shows:</span>
            <div className="row">
              <input className="input mono" style={{ width: 120 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoComplete="one-time-code" />
              <button
                className="btn primary"
                onClick={() =>
                  attempt(async () => {
                    const r = await api.enable2fa(code);
                    setCodes(r.recoveryCodes);
                    setSetup(undefined);
                    setCode("");
                    setUser(true);
                    toast("Two-factor authentication is on");
                  })
                }
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {enabled && (
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <span className="muted">
            Sign-ins ask for a code from your authenticator app.{remaining !== undefined && ` ${remaining} recovery code${remaining === 1 ? "" : "s"} left.`}
          </span>
          <div className="row">
            <input className="input mono" style={{ width: 150 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="current code" autoComplete="one-time-code" />
            <button
              className="btn"
              onClick={() =>
                attempt(async () => {
                  setCodes((await api.newRecoveryCodes(code)).recoveryCodes);
                  setCode("");
                })
              }
            >
              New recovery codes
            </button>
          </div>
          <div className="row">
            <input className="input" type="password" style={{ width: 150 }} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
            <button
              className="btn danger"
              onClick={() =>
                attempt(async () => {
                  await api.disable2fa(password, code);
                  setUser(false);
                  setPassword("");
                  setCode("");
                  toast("Two-factor authentication is off");
                })
              }
            >
              Turn off 2FA
            </button>
            <span className="muted" style={{ fontSize: 12 }}>needs password + current code</span>
          </div>
        </div>
      )}
      {error && <p className="hint warn" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

function Sessions({ api }: { api: ServerApi }) {
  const [sessions, setSessions] = useState<Awaited<ReturnType<ServerApi["sessions"]>>["sessions"]>([]);
  const load = () => api.sessions().then((r) => setSessions(r.sessions), () => {});
  useEffect(() => void load(), [api.url]);

  return (
    <div className="section">
      <h4>Signed-in devices</h4>
      <table className="kv">
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td style={{ padding: 6 }}>
                {s.userAgent?.includes("tauri") ? "Getman desktop" : (s.userAgent ?? "Unknown").slice(0, 60)}
                {s.current && <strong style={{ color: "var(--primary-strong)" }}> · this device</strong>}
              </td>
              <td className="muted" style={{ padding: 6 }}>{s.ip}</td>
              <td className="muted" style={{ padding: 6 }}>{new Date(s.lastUsedAt).toLocaleString()}</td>
              <td className="tools">
                {!s.current && (
                  <button className="btn" onClick={() => api.revokeSession(s.id).then(load, (e) => toast(errorText(e)))}>
                    Sign out
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangePassword({ api }: { api: ServerApi }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string>();
  return (
    <div className="section">
      <h4>Change password</h4>
      <div className="row">
        <input className="input" type="password" placeholder="current" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        <input className="input" type="password" placeholder="new (10+ chars)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <button
          className="btn"
          onClick={() =>
            api.changePassword(current, next).then(
              (r) => {
                setMsg(`Password changed. ${r.sessionsRevoked} other device(s) signed out.`);
                setCurrent("");
                setNext("");
              },
              (e) => setMsg(errorText(e)),
            )
          }
        >
          Change
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
