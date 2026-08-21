import { useState } from "react";
import { C, FONT_DISPLAY } from "./ui/theme";
import { Btn, Eyebrow } from "./ui/kit";
import { TeamSurface } from "./surfaces/Team";
import { PresenterSurface } from "./surfaces/Presenter";
import { HostSurface } from "./surfaces/Host";
import { EditorSurface } from "./surfaces/Editor";

const KEY = "quiz.host.key";

/**
 * Three surfaces on three devices, so they're three URLs:
 *   /                       team join + play      (phones)
 *   /host                   editor and console    (host laptop)
 *   /present/:code/:token   the projector         (TV, no password)
 * A tiny router rather than a dependency — there are only three routes.
 */
export function App() {
  const path = window.location.pathname;

  const present = path.match(/^\/present\/([A-Z0-9]{5})\/([a-f0-9]+)\/?$/i);
  if (present) return <PresenterSurface code={present[1].toUpperCase()} token={present[2]} />;

  if (path.startsWith("/host")) return <HostRoutes />;

  return <TeamSurface />;
}

function HostRoutes() {
  const [hostKey, setHostKey] = useState<string | null>(sessionStorage.getItem(KEY));
  const codeInUrl = window.location.pathname.match(/^\/host\/([A-Z0-9]{5})\/?$/i);
  const [code, setCode] = useState<string | null>(codeInUrl ? codeInUrl[1].toUpperCase() : null);

  if (!hostKey) return <PasswordGate onKey={(k) => { sessionStorage.setItem(KEY, k); setHostKey(k); }} />;

  if (code) return <HostSurface code={code} hostKey={hostKey} />;

  return (
    <EditorSurface
      hostKey={hostKey}
      onOpenRoom={(joinCode, presenterToken) => {
        // The presenter link lives on the host console behind "Open presenter".
        // It's unguessable and password-free, so it can go on a TV browser
        // without typing your admin password on a screen facing the room.
        void presenterToken;
        window.history.replaceState(null, "", `/host/${joinCode}`);
        setCode(joinCode);
      }}
    />
  );
}

function PasswordGate({ onKey }: { onKey: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: C.page, color: C.ink }}>
      <div className="w-full max-w-sm">
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 34, letterSpacing: "-0.02em", marginBottom: 16 }}>
          Host sign-in
        </div>
        <Eyebrow>Password</Eyebrow>
        <input type="password" value={value} autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value) onKey(value); }}
          className="w-full rounded-lg border px-3 py-3 mb-4 text-lg"
          style={{ background: C.card, borderColor: C.rule, color: C.ink }} />
        <Btn tone="primary" wide onClick={() => value && onKey(value)}>Sign in</Btn>
        <p className="mt-4 text-xs" style={{ color: C.inkDim }}>
          Set with <code>wrangler secret put HOST_PASSWORD</code>.
        </p>
      </div>
    </div>
  );
}
