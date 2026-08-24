import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Zap, Sparkles, Eye, Copy } from "lucide-react";
import { answerKey, maxPointsOf, parseSortAnswer, parseOrderAnswer, parseListAnswer,
  parseMatchAnswer, seededShuffle, withNominee, powerUpAllowed, powerUpSpent,
  describeAnswer, describeRound, resolveTheme,
  POWER_UP_LABELS, type ConnectionRole, type PowerUp, type Snapshot } from "@quiz/shared";
import { C, FONT_DISPLAY } from "../ui/theme";
import { Countdown, Eyebrow, Leaderboard, Pill } from "../ui/kit";
import { useQuizSocket, apiFetch, API } from "../useQuizSocket";

const TOKEN_KEY = "quiz.team.token";
const ROLE_KEY = "quiz.team.role";
const CODE_KEY = "quiz.team.code";
const ID_KEY = "quiz.team.id";

/** The token in localStorage is what makes an accidental refresh survivable:
    it identifies the team, and the snapshot restores everything else. */
export function TeamSurface() {
  const [code, setCode] = useState(localStorage.getItem(CODE_KEY) ?? "");
  const [teamId, setTeamId] = useState(localStorage.getItem(ID_KEY));
  const [role, setRole] = useState<ConnectionRole>(
    (localStorage.getItem(ROLE_KEY) as ConnectionRole) || "team"
  );
  const [notice, setNotice] = useState<string | null>(null);
  const joined = Boolean(code && teamId);

  const forget = (message?: string) => {
    localStorage.removeItem(ID_KEY);
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    setTeamId(null);
    setCode("");
    setNotice(message ?? null);
  };

  if (!joined) {
    return (
      <JoinForm
        notice={notice}
        onJoined={(c, id, r) => { setCode(c); setTeamId(id); setRole(r); setNotice(null); }}
      />
    );
  }
  return <Playing code={code} teamId={teamId!} role={role} onForget={forget} />;
}

function JoinForm({ onJoined, notice }: { onJoined: (code: string, teamId: string, role: ConnectionRole) => void; notice?: string | null }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asNominee, setAsNominee] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string; hasNominee: boolean }[]>([]);
  const [pickedTeam, setPickedTeam] = useState("");

  // A nominee joins an existing team, so they need to see which teams exist.
  useEffect(() => {
    if (!asNominee || code.length < 5) return;
    apiFetch<typeof teams>(`/api/teams?code=${code.toUpperCase()}`)
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [asNominee, code]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ teamId: string; teamToken: string }>("/api/join", {
        method: "POST",
        body: JSON.stringify({
          code: code.toUpperCase(), name,
          token: asNominee ? undefined : localStorage.getItem(TOKEN_KEY),
          asNomineeFor: asNominee ? pickedTeam : undefined,
        }),
      });
      localStorage.setItem(TOKEN_KEY, res.teamToken);
      localStorage.setItem(CODE_KEY, code.toUpperCase());
      localStorage.setItem(ID_KEY, res.teamId);
      localStorage.setItem(ROLE_KEY, asNominee ? "nominee" : "team");
      onJoined(code.toUpperCase(), res.teamId, asNominee ? "nominee" : "team");
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
        {asNominee && (
          <>
            <Eyebrow>Which team are you answering for?</Eyebrow>
            <select value={pickedTeam} onChange={(e) => setPickedTeam(e.target.value)}
              className="w-full rounded-lg border px-3 py-3 mb-4"
              style={{ background: C.card, borderColor: C.rule, color: C.ink }}>
              <option value="">Choose your team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id} disabled={t.hasNominee}>
                  {t.name}{t.hasNominee ? " — already has one" : ""}
                </option>
              ))}
            </select>
          </>
        )}

        <Eyebrow>{asNominee ? "Your name" : "Team name"}</Eyebrow>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          placeholder={asNominee ? "Sam" : "The Quizzard of Oz"}
          className="w-full rounded-lg border px-3 py-3 mb-4 text-lg"
          style={{ background: C.card, borderColor: C.rule, color: C.ink }} />
        {notice && !err && (
          <p className="mb-3 text-sm rounded-md px-3 py-2"
            style={{ background: C.warnBg, color: C.ink, border: `1px solid ${C.rule}` }}>{notice}</p>
        )}
        {err && <p className="mb-3 text-sm" style={{ color: C.marker }}>{err}</p>}
        <button onClick={submit}
          disabled={busy || code.length < 5 || !name.trim() || (asNominee && !pickedTeam)}
          className="w-full rounded-lg py-3 text-lg disabled:opacity-40"
          style={{ background: C.biro, color: C.onInk, fontWeight: 700 }}>
          {busy ? "Joining…" : asNominee ? "I'm the nominee" : "Join"}
        </button>
        <button onClick={() => { setAsNominee(!asNominee); setErr(null); }}
          className="mt-4 w-full text-sm underline" style={{ color: C.inkDim }}>
          {asNominee ? "Actually, I'm joining as a team" : "I'm my team's nominee (second phone)"}
        </button>
      </div>
    </div>
  );
}

function Playing({ code, teamId, role, onForget }: { code: string; teamId: string; role: ConnectionRole; onForget: (msg?: string) => void }) {
  const { snapshot, status, fatal, answer, send, now } = useQuizSocket({ code, role, teamId });

  /* The room this phone remembers is gone — last week's quiz, a closed room,
     or a restarted server. Drop back to the join screen instead of retrying a
     dead code. */
  useEffect(() => {
    if (fatal === "no-room") onForget("That quiz has ended. Enter the new code to join.");
  }, [fatal, onForget]);

  /* Refreshing into an already-finished quiz shouldn't strand you on last
     night's leaderboard. But if the quiz finishes while you're watching, the
     final scores are the whole payoff — so only bail when the very first
     snapshot of this page load is already "finished". */
  const sawLive = useRef(false);
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.session.state !== "finished") { sawLive.current = true; return; }
    if (!sawLive.current) onForget("That quiz has finished. Enter a new code to join.");
  }, [snapshot, onForget]);
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

    if (s.state === "info") {
      const slide = (s.quiz.infoSlides ?? []).find((x) => x.id === s.infoSlideId);
      if (!slide) return <p style={{ color: C.inkDim }}>…</p>;
      return (
        <div className="py-4">
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 28, lineHeight: 1.15, letterSpacing: "-0.02em" }}>
            {slide.title}
          </div>
          {slide.imageUrl && (
            <img src={slide.imageUrl} alt="" className="mt-4 w-full rounded-lg"
              style={{ maxHeight: "35vh", objectFit: "contain" }} />
          )}
          {slide.body && <p className="mt-3 text-sm" style={{ lineHeight: 1.6 }}>{slide.body}</p>}
        </div>
      );
    }

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
                <div style={{ color: C.biro, fontWeight: 700 }}>{describeAnswer(r, q) || "—"}</div>
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
        // Keyed on the tiebreaker so moving to the next question remounts the
        // field — otherwise React reuses the DOM node and the old answer stays.
        <TiebreakPad
          key={tb?.id ?? s.tiebreakIdx}
          tb={tb}
          initial={s.tiebreakAnswers[teamId] ?? ""}
          onChange={(v) => send({ type: "tiebreak_answer", value: v })}
        />
      );
    }

    if (!question || !round) return <p style={{ color: C.inkDim }}>Waiting…</p>;

    if (s.phase === "revealed" && round.wager) {
      return (
        <WagerPad
          max={round.maxWager ?? 5}
          current={s.wagers?.[answerKey(teamId, question.id)]}
          onSet={(n) => send({ type: "set_wager", amount: n })}
        />
      );
    }

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
        role={role}
        remaining={remaining}
        onAnswer={answer}
      />
    );
  };

  return (
    <Shell name={me.name} status={status} onForget={onForget} logoUrl={resolveTheme(s.quiz.theme).logoUrl}>
      {body()}
      {s.state !== "finished" && role !== "nominee" && (
        <PowerUps
          snapshot={snapshot}
          teamId={teamId}
          onUse={(power, opts) => send({ type: "use_powerup", power, ...opts })}
        />
      )}
    </Shell>
  );
}

function AnswerPad({ snapshot, teamId, role, remaining, onAnswer }: {
  snapshot: Snapshot; teamId: string; role: ConnectionRole; remaining: number;
  onAnswer: (questionId: string, value: string) => void;
}) {
  const s = snapshot.session;
  const round = s.quiz.rounds[s.roundIdx];
  const question = round.questions[s.questionIdx];
  const reveal = s.reveals?.[answerKey(teamId, question.id)];
  const isNomineeRound = round.answerFormat === "nominee";
  const stored = isNomineeRound && role === "nominee"
    ? s.nomineeAnswers[answerKey(teamId, question.id)]
    : s.answers[answerKey(teamId, question.id)];
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

      <p className="text-xl mb-1" style={{ fontWeight: 600, lineHeight: 1.25 }}>
        {round.answerFormat === "nominee"
          ? withNominee(question.prompt, s.teams.find((t) => t.id === teamId)?.nomineeName)
          : question.prompt}
      </p>

      {round.answerFormat === "nominee" && (
        <p className="text-xs mb-2 rounded px-2 py-1.5"
          style={{ background: role === "nominee" ? C.high : C.row, color: C.ink }}>
          {role === "nominee"
            ? "Answer honestly — your team is trying to guess what you'll say."
            : "Guess what your nominee answered. Matching them scores the point."}
        </p>
      )}
      {round.mediaType === "image" && question.mediaUrl && (
        <img src={question.mediaUrl} alt=""
          className="w-full rounded-lg mb-4"
          style={{ border: `1px solid ${C.rule}`, maxHeight: "40vh", objectFit: "contain", background: C.row }} />
      )}

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

      {round.answerFormat === "clues" && (
        <div className="mb-4 flex flex-col gap-1.5">
          {(question.clues ?? []).slice(0, s.cluesShown).map((clue, i) => (
            <div key={i} className="rounded-lg px-3 py-2 text-sm"
              style={{ background: i === s.cluesShown - 1 ? C.high : C.row, color: C.ink }}>
              <strong>{i + 1}.</strong> {clue}
            </div>
          ))}
          {!stored && (
            <p className="text-xs mt-1" style={{ color: C.inkDim }}>
              Worth {Math.max(1, maxPointsOf(round, question) - (s.cluesShown - 1))} right now —
              it drops with every clue.
            </p>
          )}
        </div>
      )}

      {(canAnswer || locked) && round.answerFormat === "clues" && (
        <FastestPad question={{}} committed={Boolean(stored)} committedValue={stored?.value}
          canAnswer={canAnswer} onCommit={(v) => onAnswer(question.id, v)} />
      )}

      {(canAnswer || locked) && round.answerFormat === "choice" && question.multi && (
        <MultiPad question={question} value={stored?.value ?? ""} canAnswer={canAnswer}
          onChange={(v) => onAnswer(question.id, v)} />
      )}

      {(canAnswer || locked) && round.answerFormat === "nominee" && (
        <div>
          <textarea rows={2} value={draft} disabled={!canAnswer}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
            placeholder={role === "nominee" ? "Your real answer" : "Your guess"}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full px-1 resize-none"
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

      {(canAnswer || locked) && round.answerFormat === "list" && (
        <ListPad question={question} value={stored?.value ?? ""} canAnswer={canAnswer}
          onChange={(v) => onAnswer(question.id, v)} />
      )}

      {(canAnswer || locked) && round.answerFormat === "match" && (
        <MatchPad question={question} teamId={teamId} value={stored?.value ?? ""}
          canAnswer={canAnswer} onChange={(v) => onAnswer(question.id, v)} />
      )}

      {(canAnswer || locked) && round.answerFormat === "choice" && !question.multi && (
        <div className="flex flex-col gap-2">
          {(question.options ?? []).map((opt, i) => {
            const active = draft === opt;
            return (
              <button key={opt} disabled={!canAnswer}
                onClick={() => { setDraft(opt); onAnswer(question.id, opt); setSaved(true); }}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-left"
                style={{
                  background: active ? C.biro : C.card,
                  color: active ? C.onInk : C.ink,
                  border: `2px solid ${active ? C.biro : C.rule}`,
                  opacity: canAnswer ? 1 : 0.6,
                }}>
                <span className="inline-flex items-center justify-center rounded-full shrink-0"
                  style={{
                    width: 30, height: 30,
                    background: active ? C.onInk : C.row,
                    color: active ? C.biro : C.inkDim,
                    fontFamily: FONT_DISPLAY, fontSize: 17,
                  }}>
                  {String.fromCharCode(65 + i)}
                </span>
                <span style={{ fontWeight: 600, fontSize: 17 }}>{opt}</span>
              </button>
            );
          })}
        </div>
      )}

      {(canAnswer || locked) && round.answerFormat === "order" && (
        <OrderPad
          question={question} teamId={teamId} value={stored?.value ?? ""}
          canAnswer={canAnswer} onChange={(v) => onAnswer(question.id, v)}
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
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
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

      {reveal?.hint && (
        <div className="mt-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: C.high, color: C.ink, fontWeight: 600 }}>
          Hint — {reveal.hint}
        </div>
      )}
      {reveal?.steal && (
        <div className="mt-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: C.high, color: C.ink }}>
          <strong>{reveal.steal.from}</strong> answered: <strong>{reveal.steal.value}</strong>
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

function Shell({ children, name, status, onForget, logoUrl }: {
  children: React.ReactNode; name: string; status: string;
  onForget?: (msg?: string) => void; logoUrl?: string;
}) {
  return (
    <div className="min-h-screen p-4" style={{ background: C.page, color: C.ink }}>
      <div className="mx-auto w-full max-w-sm">
        <div className="flex items-center gap-2 mb-3">
          {logoUrl && <img src={logoUrl} alt="" style={{ maxHeight: 24, maxWidth: 90, objectFit: "contain" }} />}
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
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
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

/** Two-step tapping: pick a word up, then drop it in a category. Buckets show
    what's in them, so the groups you're building are visible — chips beside a
    word read as labels, which is what made this incomprehensible. */
function SortPad({ question, value, canAnswer, onChange }: {
  question: { categories?: string[]; items?: { word: string; category: string }[] };
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const categories = question.categories ?? [];
  const words = (question.items ?? []).map((i) => i.word);
  const placed = parseSortAnswer(value);
  const [held, setHeld] = useState<string | null>(null);

  const unfiled = words.filter((w) => !placed[w]);
  const inCategory = (cat: string) => words.filter((w) => placed[w] === cat);

  const drop = (cat: string) => {
    if (!held) return;
    onChange(JSON.stringify({ ...placed, [held]: cat }));
    setHeld(null);
  };

  const pullOut = (word: string) => {
    const next = { ...placed };
    delete next[word];
    onChange(JSON.stringify(next));
    setHeld(word);
  };

  const chip = (word: string, selected: boolean, onClick: () => void) => (
    <button key={word} disabled={!canAnswer} onClick={onClick}
      className="rounded-full px-3 py-2 text-sm"
      style={{
        background: selected ? C.biro : C.card,
        color: selected ? C.onInk : C.ink,
        border: `2px solid ${selected ? C.biro : C.rule}`,
        fontWeight: 600, opacity: canAnswer ? 1 : 0.6,
      }}>
      {word}
    </button>
  );

  return (
    <div>
      <div className="mb-3">
        <div className="text-xs mb-1.5" style={{ color: unfiled.length === 0 ? C.correct : C.inkDim, fontWeight: 600 }}>
          {unfiled.length === 0
            ? "All filed"
            : held
            ? `Now tap a group for "${held}"`
            : `${unfiled.length} left — tap a word to pick it up`}
        </div>
        <div className="flex flex-wrap gap-1.5 min-h-10">
          {unfiled.map((w) => chip(w, held === w, () => setHeld(held === w ? null : w)))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {categories.map((cat) => {
          const contents = inCategory(cat);
          const armed = Boolean(held);
          return (
            <button key={cat} disabled={!canAnswer || !held} onClick={() => drop(cat)}
              className="text-left rounded-xl p-3"
              style={{
                background: armed ? "rgba(42,71,196,0.06)" : C.card,
                border: `2px ${armed ? "dashed" : "solid"} ${armed ? C.biro : C.rule}`,
                cursor: armed ? "pointer" : "default",
              }}>
              <div className="text-xs uppercase mb-1.5"
                style={{ color: C.inkDim, letterSpacing: "0.14em", fontWeight: 700 }}>
                {cat}
              </div>
              {contents.length === 0 ? (
                <div className="text-sm" style={{ color: C.inkDim }}>
                  {armed ? "Tap to drop it here" : "Empty"}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {contents.map((w) => (
                    <span key={w}
                      onClick={(e) => { e.stopPropagation(); if (canAnswer) pullOut(w); }}
                      className="rounded-full px-3 py-1.5 text-sm"
                      style={{ background: C.biro, color: C.onInk, fontWeight: 600 }}>
                      {w}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {categories.length < 2 && (
        <p className="mt-3 text-xs" style={{ color: C.marker }}>
          This question only has one group, so there's nothing to sort.
        </p>
      )}
    </div>
  );
}

function TiebreakPad({ tb, initial, onChange }: {
  tb?: { id: string; prompt: string; mode: "exact" | "closest" };
  initial: string;
  onChange: (value: string) => void;
}) {
  // Local state so typing stays instant; seeded from the server so a refresh
  // mid-tiebreaker restores what was already sent.
  const [value, setValue] = useState(initial);
  return (
    <>
      <Eyebrow>Tiebreaker{tb?.mode === "closest" ? " · closest wins" : ""}</Eyebrow>
      <p className="text-lg mb-4" style={{ fontWeight: 600 }}>{tb?.prompt}</p>
      <input
        autoFocus value={value}
        placeholder={tb?.mode === "closest" ? "A number" : "Your answer"}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        inputMode={tb?.mode === "closest" ? "numeric" : "text"}
        onChange={(e) => { setValue(e.target.value); onChange(e.target.value); }}
        className="w-full rounded-lg border px-3 py-3 text-lg"
        style={{ background: C.card, borderColor: C.rule, color: C.biro }} />
    </>
  );
}


/** Tap items in the order you want them. The first tap is 1, the next is 2,
    and so on — tapping a numbered item takes it back out and renumbers the
    rest, so there's no way to end up with a gap. */
function OrderPad({ question, teamId, value, canAnswer, onChange }: {
  question: { id: string; sequence?: string[] };
  teamId: string;
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const truth = question.sequence ?? [];
  // Presenting them in the stored order would hand over the answer.
  const shown = useMemo(
    () => seededShuffle(truth, `${teamId}:${question.id}`),
    [truth, teamId, question.id]
  );
  const chosen = parseOrderAnswer(value);

  const toggle = (item: string) => {
    const at = chosen.indexOf(item);
    const next = at >= 0 ? chosen.filter((x) => x !== item) : [...chosen, item];
    onChange(JSON.stringify(next));
  };

  const remaining = shown.length - chosen.length;

  return (
    <div>
      <div className="text-xs mb-2" style={{ color: remaining === 0 ? C.correct : C.inkDim, fontWeight: 600 }}>
        {remaining === 0
          ? "All placed — tap one to change your mind"
          : `Tap in order · ${chosen.length + 1} of ${shown.length} next`}
      </div>
      <div className="flex flex-col gap-2">
        {shown.map((item) => {
          const at = chosen.indexOf(item);
          const placed = at >= 0;
          return (
            <button key={item} disabled={!canAnswer} onClick={() => toggle(item)}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left"
              style={{
                background: placed ? C.biro : C.card,
                color: placed ? C.onInk : C.ink,
                border: `2px solid ${placed ? C.biro : C.rule}`,
                opacity: canAnswer ? 1 : 0.6,
              }}>
              <span
                className="inline-flex items-center justify-center rounded-full shrink-0"
                style={{
                  width: 30, height: 30,
                  background: placed ? C.onInk : C.row,
                  color: placed ? C.biro : C.inkDim,
                  fontFamily: FONT_DISPLAY, fontSize: 17,
                }}>
                {placed ? at + 1 : "·"}
              </span>
              <span style={{ fontWeight: 600, fontSize: 17 }}>{item}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}


/** One box per answer asked for, so partial credit is obvious as you fill it
    in — a single textarea makes "name 7 of 13" a marking chore. */
function ListPad({ question, value, canAnswer, onChange }: {
  question: { requiredCount?: number; listAnswers?: string[] };
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const count = question.requiredCount ?? (question.listAnswers ?? []).length;
  const current = parseListAnswer(value);
  const rows = Array.from({ length: count }, (_, i) => current[i] ?? "");

  const set = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    onChange(JSON.stringify(next));
  };

  const filled = rows.filter((r) => r.trim()).length;

  return (
    <div>
      <div className="text-xs mb-2" style={{ color: filled === count ? C.correct : C.inkDim, fontWeight: 600 }}>
        {filled} of {count} named
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: C.biroDim, minWidth: 18 }}>{i + 1}</span>
            <input value={row} disabled={!canAnswer}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(e) => set(i, e.target.value)}
              className="flex-1 min-w-0 rounded-lg border px-3 py-2.5"
              style={{ background: C.card, borderColor: C.rule, color: C.biro, fontSize: 17, fontWeight: 500 }} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs" style={{ color: C.inkDim }}>
        Any order. One point each — a wrong guess doesn't cost you a right one.
      </p>
    </div>
  );
}

/** Same pick-then-place gesture as the sorting round, so there's only one
    interaction to learn across the night. */
function MatchPad({ question, teamId, value, canAnswer, onChange }: {
  question: { id: string; pairs?: { left: string; right: string }[] };
  teamId: string;
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const pairs = question.pairs ?? [];
  const rights = useMemo(
    () => seededShuffle(pairs.map((p) => p.right), `${teamId}:${question.id}`),
    [pairs, teamId, question.id]
  );
  const chosen = parseMatchAnswer(value);
  const [held, setHeld] = useState<string | null>(null);

  const used = new Set(Object.values(chosen));
  const pool = rights.filter((r) => !used.has(r));

  const place = (left: string) => {
    if (!held) return;
    onChange(JSON.stringify({ ...chosen, [left]: held }));
    setHeld(null);
  };

  const takeBack = (left: string) => {
    const next = { ...chosen };
    const was = next[left];
    delete next[left];
    onChange(JSON.stringify(next));
    setHeld(was ?? null);
  };

  return (
    <div>
      <div className="text-xs mb-1.5" style={{ color: pool.length === 0 ? C.correct : C.inkDim, fontWeight: 600 }}>
        {pool.length === 0 ? "All matched" : held ? `Now tap where "${held}" belongs` : `${pool.length} left — tap one to pick it up`}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3 min-h-10">
        {pool.map((r) => (
          <button key={r} disabled={!canAnswer} onClick={() => setHeld(held === r ? null : r)}
            className="rounded-full px-3 py-2 text-sm"
            style={{
              background: held === r ? C.biro : C.card,
              color: held === r ? C.onInk : C.ink,
              border: `2px solid ${held === r ? C.biro : C.rule}`,
              fontWeight: 600, opacity: canAnswer ? 1 : 0.6,
            }}>
            {r}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {pairs.map((p) => {
          const answer = chosen[p.left];
          const armed = Boolean(held) && !answer;
          return (
            <button key={p.left} disabled={!canAnswer || (!held && !answer)}
              onClick={() => (answer ? takeBack(p.left) : place(p.left))}
              className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left"
              style={{
                background: C.card,
                border: `2px ${armed ? "dashed" : "solid"} ${armed ? C.biro : C.rule}`,
              }}>
              <span style={{ fontWeight: 600 }}>{p.left}</span>
              {answer ? (
                <span className="rounded-full px-3 py-1.5 text-sm"
                  style={{ background: C.biro, color: C.onInk, fontWeight: 600 }}>{answer}</span>
              ) : (
                <span className="text-sm" style={{ color: C.inkDim }}>{armed ? "Tap to place" : "—"}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}



/** Ticking everything shouldn't be a strategy, so wrong ticks cancel right
    ones. The count tells teams how many to look for. */
function MultiPad({ question, value, canAnswer, onChange }: {
  question: { options?: string[]; correctOptions?: string[] };
  value: string;
  canAnswer: boolean;
  onChange: (value: string) => void;
}) {
  const picked = parseListAnswer(value);
  const wanted = (question.correctOptions ?? []).length;

  const toggle = (opt: string) => {
    const next = picked.includes(opt) ? picked.filter((x) => x !== opt) : [...picked, opt];
    onChange(JSON.stringify(next));
  };

  return (
    <div>
      <div className="text-xs mb-2" style={{ color: picked.length === wanted ? C.correct : C.inkDim, fontWeight: 600 }}>
        Pick {wanted} — {picked.length} ticked. A wrong tick cancels a right one.
      </div>
      <div className="flex flex-col gap-2">
        {(question.options ?? []).map((opt, i) => {
          const on = picked.includes(opt);
          return (
            <button key={opt} disabled={!canAnswer} onClick={() => toggle(opt)}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-left"
              style={{
                background: on ? C.biro : C.card,
                color: on ? C.onInk : C.ink,
                border: `2px solid ${on ? C.biro : C.rule}`,
                opacity: canAnswer ? 1 : 0.6,
              }}>
              <span className="inline-flex items-center justify-center rounded shrink-0"
                style={{
                  width: 28, height: 28,
                  background: on ? C.onInk : C.row,
                  color: on ? C.biro : C.inkDim,
                  fontFamily: FONT_DISPLAY, fontSize: 16,
                }}>
                {on ? "✓" : String.fromCharCode(65 + i)}
              </span>
              <span style={{ fontWeight: 600, fontSize: 17 }}>{opt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Staked before the question appears, which is what makes it a gamble. */
function WagerPad({ max, current, onSet }: {
  max: number; current: number | undefined; onSet: (n: number) => void;
}) {
  const steps = Array.from({ length: max + 1 }, (_, i) => i);
  return (
    <div className="text-center py-6">
      <Eyebrow>Place your stake</Eyebrow>
      <p className="text-sm mb-4" style={{ color: C.inkDim }}>
        You haven't seen the question yet. Get it right and you win your stake;
        get it wrong and you lose it.
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {steps.map((n) => {
          const on = current === n;
          return (
            <button key={n} onClick={() => onSet(n)}
              className="rounded-full"
              style={{
                width: 52, height: 52,
                background: on ? C.biro : C.card,
                color: on ? C.onInk : C.ink,
                border: `2px solid ${on ? C.biro : C.rule}`,
                fontFamily: FONT_DISPLAY, fontSize: 22,
              }}>
              {n}
            </button>
          );
        })}
      </div>
      {current != null && (
        <p className="mt-4 text-sm" style={{ color: C.correct, fontWeight: 600 }}>
          Staked {current}. Change it until the question appears.
        </p>
      )}
    </div>
  );
}

/** One of each, once a game, and only on rounds the host opened up. */
function PowerUps({ snapshot, teamId, onUse }: {
  snapshot: Snapshot;
  teamId: string;
  onUse: (power: PowerUp, opts?: { roundIdx?: number; targetTeamId?: string }) => void;
}) {
  const s = snapshot.session;
  const me = s.teams.find((t) => t.id === teamId);
  const round = s.quiz.rounds[s.roundIdx];
  const [picking, setPicking] = useState<PowerUp | null>(null);

  const offered = (["double", "steal", "hint"] as PowerUp[]).filter((p) => {
    if (powerUpSpent(me, p)) return false;
    if (p === "double") {
      // Nominated ahead of a round, so it's offered between rounds.
      return s.quiz.rounds.some((r, i) => powerUpAllowed(r, "double") && (s.state === "lobby" || i > s.roundIdx));
    }
    return powerUpAllowed(round, p) && s.phase === "answering";
  });

  const spent = (["double", "steal", "hint"] as PowerUp[]).filter((p) => powerUpSpent(me, p));
  if (offered.length === 0 && spent.length === 0) return null;

  if (picking === "double") {
    const rounds = s.quiz.rounds
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => powerUpAllowed(r, "double") && (s.state === "lobby" || i > s.roundIdx));
    return (
      <PickList title="Which round should count double?" onCancel={() => setPicking(null)}
        items={rounds.map(({ r, i }) => ({ key: r.id, label: `Round ${i + 1} — ${r.title}`, onPick: () => { onUse("double", { roundIdx: i }); setPicking(null); } }))} />
    );
  }

  if (picking === "steal") {
    const others = s.teams.filter((t) => t.id !== teamId);
    return (
      <PickList title="Whose answer do you want to see?" onCancel={() => setPicking(null)}
        items={others.map((t) => ({ key: t.id, label: t.name, onPick: () => { onUse("steal", { targetTeamId: t.id }); setPicking(null); } }))} />
    );
  }

  const icon = (p: PowerUp) =>
    p === "double" ? <Sparkles size={14} /> : p === "steal" ? <Copy size={14} /> : <Eye size={14} />;

  return (
    <div className="mt-5">
      <div className="text-xs uppercase mb-2"
        style={{ color: C.inkDim, letterSpacing: "0.14em", fontWeight: 700 }}>
        Power-ups — one of each, all night
      </div>
      <div className="flex flex-wrap gap-2">
        {offered.map((p) => (
          <button key={p}
            onClick={() => (p === "hint" ? onUse("hint") : setPicking(p))}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm"
            style={{ background: C.card, border: `2px solid ${C.high}`, color: C.ink, fontWeight: 700 }}>
            {icon(p)} {POWER_UP_LABELS[p].name}
          </button>
        ))}
        {spent.map((p) => (
          <span key={p} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm"
            style={{ background: C.row, color: C.inkDim, textDecoration: "line-through" }}>
            {icon(p)} {POWER_UP_LABELS[p].name}
          </span>
        ))}
      </div>
    </div>
  );
}

function PickList({ title, items, onCancel }: {
  title: string;
  items: { key: string; label: string; onPick: () => void }[];
  onCancel: () => void;
}) {
  return (
    <div className="mt-5 rounded-lg p-3" style={{ background: C.row, border: `1px solid ${C.rule}` }}>
      <div className="text-xs uppercase mb-2"
        style={{ color: C.inkDim, letterSpacing: "0.14em", fontWeight: 700 }}>{title}</div>
      <div className="flex flex-col gap-1.5">
        {items.length === 0 && <p className="text-sm" style={{ color: C.inkDim }}>Nothing available.</p>}
        {items.map((it) => (
          <button key={it.key} onClick={it.onPick}
            className="rounded-md px-3 py-2 text-left"
            style={{ background: C.card, border: `1px solid ${C.rule}`, fontWeight: 600 }}>
            {it.label}
          </button>
        ))}
        <button onClick={onCancel} className="text-xs mt-1" style={{ color: C.inkDim }}>Not yet</button>
      </div>
    </div>
  );
}
