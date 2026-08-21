import { useEffect, useRef, useState } from "react";
import { Check, Zap } from "lucide-react";
import { answerKey, maxPointsOf, parseSortAnswer, type Snapshot } from "@quiz/shared";
import { C, FONT_DISPLAY } from "../ui/theme";
import { Countdown, Eyebrow, Leaderboard, Pill } from "../ui/kit";
import { useQuizSocket, apiFetch, API } from "../useQuizSocket";

const TOKEN_KEY = "quiz.team.token";
const CODE_KEY = "quiz.team.code";
const ID_KEY = "quiz.team.id";

/** The token in localStorage is what makes an accidental refresh survivable:
    it identifies the team, and the snapshot restores everything else. */
export function TeamSurface() {
  const [code, setCode] = useState(localStorage.getItem(CODE_KEY) ?? "");
  const [teamId, setTeamId] = useState(localStorage.getItem(ID_KEY));
  const [notice, setNotice] = useState<string | null>(null);
  const joined = Boolean(code && teamId);

  const forget = (message?: string) => {
    localStorage.removeItem(ID_KEY);
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(TOKEN_KEY);
    setTeamId(null);
    setCode("");
    setNotice(message ?? null);
  };

  if (!joined) {
    return (
      <JoinForm
        notice={notice}
        onJoined={(c, id) => { setCode(c); setTeamId(id); setNotice(null); }}
      />
    );
  }
  return <Playing code={code} teamId={teamId!} onForget={forget} />;
}

function JoinForm({ onJoined, notice }: { onJoined: (code: string, teamId: string) => void; notice?: string | null }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ teamId: string; teamToken: string }>("/api/join", {
        method: "POST",
        body: JSON.stringify({ code: code.toUpperCase(), name, token: localStorage.getItem(TOKEN_KEY) }),
      });
      localStorage.setItem(TOKEN_KEY, res.teamToken);
      localStorage.setItem(CODE_KEY, code.toUpperCase());
      localStorage.setItem(ID_KEY, res.teamId);
      onJoined(code.toUpperCase(), res.teamId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: C.page, color: C.ink }}>
      <div className="w-full max-w-sm">
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 38, letterSpacing: "-0.02em", marginBottom: 18 }}>
          Join the quiz
        </div>
        <Eyebrow>Join code</Eyebrow>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={5} autoCapitalize="characters" autoCorrect="off" placeholder="K7QP2"
          className="w-full rounded-lg border px-3 py-3 mb-4"
          style={{ background: C.card, borderColor: C.rule, color: C.biro,
                   fontFamily: "'DM Mono',monospace", fontSize: 30, letterSpacing: "0.1em" }} />
        <Eyebrow>Team name</Eyebrow>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          placeholder="The Quizzard of Oz"
          className="w-full rounded-lg border px-3 py-3 mb-4 text-lg"
          style={{ background: C.card, borderColor: C.rule, color: C.ink }} />
        {notice && !err && (
          <p className="mb-3 text-sm rounded-md px-3 py-2"
            style={{ background: C.warnBg, color: C.ink, border: `1px solid ${C.rule}` }}>{notice}</p>
        )}
        {err && <p className="mb-3 text-sm" style={{ color: C.marker }}>{err}</p>}
        <button onClick={submit} disabled={busy || code.length < 5 || !name.trim()}
          className="w-full rounded-lg py-3 text-lg disabled:opacity-40"
          style={{ background: C.biro, color: C.onInk, fontWeight: 700 }}>
          {busy ? "Joining…" : "Join"}
        </button>
      </div>
    </div>
  );
}

function Playing({ code, teamId, onForget }: { code: string; teamId: string; onForget: (msg?: string) => void }) {
  const { snapshot, status, fatal, answer, send, now } = useQuizSocket({ code, role: "team", teamId });

  /* The room this phone remembers is gone — last week's quiz, or a restarted
     server. Drop back to the join screen instead of retrying a dead code. */
  useEffect(() => {
    if (fatal === "no-room") onForget("That quiz has ended. Enter the new code to join.");
  }, [fatal, onForget]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  void tick;

  if (!snapshot) return <Waiting status={status} onForget={onForget} />;
  const s = snapshot.session;
  const me = s.teams.find((t) => t.id === teamId);
  if (!me) {
    // Host removed this team, or the session was replaced.
    return (
      <Shell name="—" status={status} onForget={onForget}>
        <div className="text-center py-12">
          <p style={{ fontWeight: 600 }}>You're not in this quiz any more.</p>
          <button className="mt-4 underline" style={{ color: C.biro }} onClick={() => onForget()}>Join again</button>
        </div>
      </Shell>
    );
  }

  const round = s.quiz.rounds[s.roundIdx];
  const question = round?.questions[s.questionIdx];
  const remaining = s.questionStartedAt && round ? round.timeLimit - (now() - s.questionStartedAt) / 1000 : 0;

  const body = () => {
    if (s.state === "lobby")
      return (
        <div className="text-center py-12">
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 30, letterSpacing: "-0.02em" }}>{me.name}</div>
          <p className="mt-3 text-sm" style={{ color: C.inkDim }}>You're in. The host starts things off.</p>
        </div>
      );

    if (s.state === "break") {
      const left = s.breakEndsAt ? (s.breakEndsAt - now()) / 1000 : 0;
      return (
        <div className="text-center py-10">
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 34, letterSpacing: "-0.02em" }}>Break</div>
          <div className="my-6 flex justify-center">
            <Countdown
              remaining={left}
              total={Math.max(1, ((s.breakEndsAt ?? 0) - (s.breakStartedAt ?? 0)) / 1000)}
              size="md"
            />
          </div>
          <p className="text-sm" style={{ color: C.inkDim }}>
            {left <= 0 ? "Starting again shortly." : "Keep this page open — you'll be back in automatically."}
          </p>
        </div>
      );
    }

    if (s.state === "round_review" && s.reviewRound != null) {
      const r = s.quiz.rounds[s.reviewRound];
      return (
        <>
          <Eyebrow>Round {s.reviewRound + 1} answers</Eyebrow>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, marginBottom: 16 }}>{r.title}</div>
          <ol className="flex flex-col gap-2">
            {r.questions.map((q, i) => (
              <li key={q.id} className="rounded-md px-3 py-2.5" style={{ background: C.row }}>
                <div className="text-sm" style={{ color: C.inkDim }}>{i + 1}. {q.prompt}</div>
                <div style={{ color: C.biro, fontWeight: 700 }}>{q.correct}</div>
              </li>
            ))}
          </ol>
        </>
      );
    }

    if (s.state === "leaderboard" || s.state === "finished") {
      const pos = snapshot.standings.findIndex((t) => t.teamId === teamId) + 1;
      return (
        <>
          <div className="text-center mb-5">
            <Eyebrow>Your position</Eyebrow>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 54, color: C.biro, letterSpacing: "-0.02em" }}>{pos}</div>
          </div>
          <Leaderboard standings={snapshot.standings} />
        </>
      );
    }

    if (s.state === "tiebreaker") {
      const tb = s.quiz.tiebreakers[s.tiebreakIdx];
      if (!s.tiebreakTeams.includes(teamId)) {
        const names = s.tiebreakTeams.map((id) => s.teams.find((t) => t.id === id)?.name).filter(Boolean);
        return (
          <div className="text-center py-12">
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 27, color: C.marker }}>Tiebreaker</div>
            <p className="mt-3" style={{ fontWeight: 600 }}>{names.join(" vs ")}</p>
            <p className="mt-2 text-sm" style={{ color: C.inkDim }}>You're out of this one. Enjoy the show.</p>
          </div>
        );
      }
      return (
        <>
          <Eyebrow>Tiebreaker{tb?.mode === "closest" ? " · closest wins" : ""}</Eyebrow>
          <p className="text-lg mb-4" style={{ fontWeight: 600 }}>{tb?.prompt}</p>
          <input autoFocus placeholder={tb?.mode === "closest" ? "A number" : "Your answer"}
            inputMode={tb?.mode === "closest" ? "numeric" : "text"}
            onChange={(e) => send({ type: "tiebreak_answer", value: e.target.value })}
            className="w-full rounded-lg border px-3 py-3 text-lg"
            style={{ background: C.card, borderColor: C.rule, color: C.biro }} />
        </>
      );
    }

    if (!question || !round) return <p style={{ color: C.inkDim }}>Waiting…</p>;

    if (s.phase === "idle")
      return (
        <div className="text-center py-12">
          <Eyebrow>Round {s.roundIdx + 1}</Eyebrow>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 29, letterSpacing: "-0.02em" }}>{round.title}</div>
          <p className="mt-3 text-sm" style={{ color: C.inkDim }}>Pens ready.</p>
        </div>
      );

    return (
      <AnswerPad
        key={question.id}
        snapshot={snapshot}
        teamId={teamId}
        remaining={remaining}
        onAnswer={answer}
      />
    );
  };

  return <Shell name={me.name} status={status} onForget={onForget}>{body()}</Shell>;
}

function AnswerPad({ snapshot, teamId, remaining, onAnswer }: {
  snapshot: Snapshot; teamId: string; remaining: number;
  onAnswer: (questionId: string, value: string) => void;
}) {
  const s = snapshot.session;
  const round = s.quiz.rounds[s.roundIdx];
  const question = round.questions[s.questionIdx];
  const stored = s.answers[answerKey(teamId, question.id)];
  const [draft, setDraft] = useState(stored?.value ?? "");
  const [saved, setSaved] = useState(Boolean(stored));
  const first = useRef(true);

  const expired = remaining <= 0;
  const canAnswer = s.phase === "answering" && !expired;
  const locked = s.phase === "locked" || (s.phase === "answering" && expired);

  const flushed = useRef(false);
  useEffect(() => {
    if (!expired || flushed.current) return;
    flushed.current = true;
    if (draft) onAnswer(question.id, draft);
  }, [expired, draft, question.id, onAnswer]);

  /* Debounced autosave, which is why there is no submit button: nothing to
     forget under time pressure, and nothing lost to an accidental refresh. */
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!canAnswer || draft === "") return;
    const id = setTimeout(() => { onAnswer(question.id, draft); setSaved(true); }, 500);
    return () => clearTimeout(id);
  }, [draft, canAnswer, question.id, onAnswer]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <Eyebrow>Q{s.questionIdx + 1} of {round.questions.length}</Eyebrow>
        {canAnswer && <Countdown remaining={remaining} total={round.timeLimit} size="sm" />}
      </div>

      <p className="text-xl mb-1" style={{ fontWeight: 600, lineHeight: 1.25 }}>{question.prompt}</p>
      <p className="text-xs mb-5" style={{ color: C.inkDim }}>
        Worth {maxPointsOf(round, question)} {maxPointsOf(round, question) === 1 ? "point" : "points"}
      </p>

      {s.phase === "playing_media" && (
        <div className="text-center py-6 rounded-lg" style={{ background: C.row }}>
          <p style={{ color: C.biro, fontWeight: 600 }}>
            {round.mediaType === "audio" ? "Listen up" : "Eyes on the screen"}
          </p>
          <p className="text-sm mt-1" style={{ color: C.inkDim }}>The clock starts when the clip ends</p>
        </div>
      )}

      {(canAnswer || locked) && round.answerFormat === "yes_no" && (
        <div className="grid grid-cols-2 gap-3">
          {["Yes", "No"].map((v) => {
            const active = draft === v;
            return (
              <button key={v} disabled={!canAnswer}
                onClick={() => { setDraft(v); onAnswer(question.id, v); setSaved(true); }}
                className="rounded-xl py-6 text-2xl flex items-center justify-center gap-2"
                style={{
                  background: active ? C.biro : C.card,
                  color: active ? C.onInk : C.ink,
                  border: `2px solid ${active ? C.biro : C.rule}`,
                  fontFamily: FONT_DISPLAY, letterSpacing: "-0.02em",
                  opacity: canAnswer ? 1 : 0.5,
                }}>
                {active && <Check size={20} strokeWidth={3} />}{v}
              </button>
            );
          })}
        </div>
      )}

      {(canAnswer || locked) && round.answerFormat === "fastest" && (
        <FastestPad
          question={question} committed={Boolean(stored)} committedValue={stored?.value}
          canAnswer={canAnswer} onCommit={(v) => onAnswer(question.id, v)}
        />
      )}

      {(canAnswer || locked) && round.answerFormat === "sort" && (
        <SortPad
          question={question} value={stored?.value ?? ""} canAnswer={canAnswer}
          onChange={(v) => onAnswer(question.id, v)}
        />
      )}

      {(canAnswer || locked) && round.answerFormat === "text" && (
        <div>
          {/* A ruled line to write on, in biro blue — not a form field. */}
          <textarea rows={2} value={draft} disabled={!canAnswer}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
            placeholder="Write your answer" className="w-full px-1 resize-none"
            style={{
              background: `repeating-linear-gradient(to bottom, transparent 0 43px, ${C.rule} 43px 44px)`,
              lineHeight: "44px", fontSize: 22, fontWeight: 500, color: C.biro,
              border: "none", padding: 0, opacity: canAnswer ? 1 : 0.55,
            }} />
          <div className="h-5 mt-1 text-xs flex items-center gap-1" style={{ color: saved ? C.correct : C.inkDim }}>
            {draft && (saved ? <><Check size={12} /> Saved</> : "Saving…")}
          </div>
        </div>
      )}

      {locked && (
        <div className="mt-4 text-center rounded-lg py-3"
          style={{ background: C.warnBg, color: C.marker, fontWeight: 700, border: `1px solid ${C.marker}` }}>
          Locked
        </div>
      )}
    </div>
  );
}

function Shell({ children, name, status, onForget }: {
  children: React.ReactNode; name: string; status: string; onForget?: (msg?: string) => void;
}) {
  return (
    <div className="min-h-screen p-4" style={{ background: C.page, color: C.ink }}>
      <div className="mx-auto w-full max-w-sm">
        <div className="flex items-center gap-2 mb-3">
          <span className="flex-1 text-sm truncate" style={{ fontWeight: 600 }}>{name}</span>
          <Pill tone={status === "open" ? "live" : "danger"}>{status === "open" ? "connected" : status}</Pill>
          {onForget && (
            <button onClick={() => onForget()} className="text-xs underline" style={{ color: C.inkDim }}>
              leave
            </button>
          )}
        </div>
        <div className="rounded-2xl border p-5" style={{ borderColor: C.rule, background: C.card, minHeight: "60vh" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Waiting({ status, onForget }: { status: string; onForget?: (msg?: string) => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: C.page, color: C.inkDim }}>
      <span>{status === "closed" ? "Reconnecting…" : "Connecting…"}</span>
      {onForget && (
        <button onClick={() => onForget()} className="text-sm underline" style={{ color: C.biro }}>
          Join a different quiz
        </button>
      )}
    </div>
  );
}

export { API };


/** Fastest rounds are the one place with a commit button. Autosave would make
    "first" meaningless, so the answer is sent once and can't be changed. */
function FastestPad({ question, committed, committedValue, canAnswer, onCommit }: {
  question: { fastestMode?: "exact" | "closest" };
  committed: boolean;
  committedValue?: string;
  canAnswer: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const numeric = question.fastestMode === "closest";

  if (committed) {
    return (
      <div className="rounded-xl border px-4 py-5 text-center"
        style={{ borderColor: C.biro, background: C.card }}>
        <div className="text-xs uppercase mb-1" style={{ color: C.inkDim, letterSpacing: "0.16em", fontWeight: 700 }}>
          Locked in
        </div>
        <div style={{ fontSize: 26, fontWeight: 600, color: C.biro }}>{committedValue}</div>
        <p className="mt-2 text-xs" style={{ color: C.inkDim }}>
          No changes in a speed round — that's the point.
        </p>
      </div>
    );
  }

  return (
    <div>
      <input
        autoFocus value={draft} disabled={!canAnswer}
        inputMode={numeric ? "numeric" : "text"}
        placeholder={numeric ? "A number" : "Your answer"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) onCommit(draft.trim()); }}
        className="w-full rounded-lg border px-3 py-3 mb-3"
        style={{ background: C.card, borderColor: C.rule, color: C.biro, fontSize: 22, fontWeight: 500 }}
      />
      <button
        onClick={() => draft.trim() && onCommit(draft.trim())}
        disabled={!canAnswer || !draft.trim()}
        className="w-full rounded-xl py-4 flex items-center justify-center gap-2 disabled:opacity-40"
        style={{ background: C.biro, color: C.onInk, fontWeight: 700, fontSize: 18 }}>
        <Zap size={18} /> Lock it in
      </button>
      <p className="mt-2 text-xs text-center" style={{ color: C.inkDim }}>
        Fastest correct answer scores more. You only get one go.
      </p>
    </div>
  );
}

/** Chips rather than drag-and-drop: dragging a dozen words on a phone in a
    dark pub is miserable, and tapping is faster anyway. */
function SortPad({ question, value, canAnswer, onChange }: {
  question: { categories?: string[]; items?: { word: string; category: string }[] };
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const categories = question.categories ?? [];
  const words = (question.items ?? []).map((i) => i.word);
  const placed = parseSortAnswer(value);

  const assign = (word: string, category: string) => {
    const next = { ...placed };
    if (next[word] === category) delete next[word];
    else next[word] = category;
    onChange(JSON.stringify(next));
  };

  const done = words.filter((w) => placed[w]).length;

  return (
    <div>
      <div className="text-xs mb-2" style={{ color: done === words.length ? C.correct : C.inkDim }}>
        {done} of {words.length} filed
      </div>
      <div className="flex flex-col gap-2">
        {words.map((word) => (
          <div key={word} className="rounded-lg border p-2" style={{ background: C.card, borderColor: C.rule }}>
            <div className="mb-1.5" style={{ fontWeight: 600 }}>{word}</div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => {
                const active = placed[word] === cat;
                return (
                  <button key={cat} disabled={!canAnswer} onClick={() => assign(word, cat)}
                    className="rounded-full px-3 py-1.5 text-sm"
                    style={{
                      background: active ? C.biro : C.row,
                      color: active ? C.onInk : C.ink,
                      border: `1px solid ${active ? C.biro : C.rule}`,
                      fontWeight: active ? 600 : 400,
                      opacity: canAnswer ? 1 : 0.6,
                    }}>
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
