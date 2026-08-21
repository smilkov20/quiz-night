import { useEffect, useState } from "react";
import { Plus, Trash2, Check, AlertTriangle, Timer as TimerIcon, Play, Download, Upload, ChevronUp, ChevronDown } from "lucide-react";
import type { Quiz, Question, Round, Tiebreaker } from "@quiz/shared";
import { C, FONT_DISPLAY } from "../ui/theme";
import { Btn, Eyebrow, Panel, Pill, useConfirm } from "../ui/kit";
import { apiFetch, ApiError } from "../useQuizSocket";
import { seedQuiz } from "../seed";
import { parseYouTube, parseStamp, clipLen } from "../ui/YouTubeStage";
import { roundIcon } from "./Host";

const LIBRARY_KEY = "quiz.library";

/** The screen you'll spend hours in every week, so it gets to be dense. */
const STORE = "quiz.library";

export function EditorSurface({ hostKey, onOpenRoom }: {
  hostKey: string;
  onOpenRoom: (code: string, presenterToken: string) => void;
}) {
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    const stored = localStorage.getItem(STORE);
    const all: Quiz[] = stored ? JSON.parse(stored) : [seedQuiz];
    setQuizzes(all);
    setQuiz(all[0] ?? null);
    setOpen(all[0]?.rounds[0]?.id ?? null);
  }, []);

  /** Autosave to the browser. Nothing to provision, nothing to expire —
      use Export before you rely on it, because clearing site data wipes it. */
  useEffect(() => {
    if (!quiz) return;
    const next = quizzes.some((q) => q.id === quiz.id)
      ? quizzes.map((q) => (q.id === quiz.id ? quiz : q))
      : [...quizzes, quiz];
    localStorage.setItem(STORE, JSON.stringify(next));
    setSaved(Date.now());
  }, [quiz]);

  const exportJson = () => {
    if (!quiz) return;
    const blob = new Blob([JSON.stringify(quiz, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${quiz.title.replace(/[^\w]+/g, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Quiz;
        if (!parsed.rounds) throw new Error("That file isn't a quiz");
        const withId = { ...parsed, id: parsed.id || `quiz${Date.now()}` };
        setQuizzes((qs) => [withId, ...qs.filter((q) => q.id !== withId.id)]);
        setQuiz(withId);
      } catch (e) { setErr((e as Error).message); }
    };
    reader.readAsText(file);
  };

  const openRoom = async () => {
    if (!quiz) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ joinCode: string; presenterToken: string }>(
        "/api/sessions", { method: "POST", body: JSON.stringify({ quiz }) }, hostKey
      );
      onOpenRoom(res.joinCode, res.presenterToken);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        sessionStorage.removeItem("quiz.host.key");
        window.location.assign("/host");
        return;
      }
      setErr((e as Error).message);
    } finally { setSaving(false); }
  };

  if (err) return <Centered>{err}</Centered>;
  if (!quiz) return <Centered>Loading…</Centered>;

  const patchRound = (id: string, patch: Partial<Round>) =>
    setQuiz({ ...quiz, rounds: quiz.rounds.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const patchQuestion = (rid: string, qid: string, patch: Partial<Question>) =>
    setQuiz({
      ...quiz,
      rounds: quiz.rounds.map((r) =>
        r.id !== rid ? r : { ...r, questions: r.questions.map((q) => (q.id === qid ? { ...q, ...patch } : q)) }),
    });

  const addQuestion = (rid: string) =>
    setQuiz({
      ...quiz,
      rounds: quiz.rounds.map((r) => {
        if (r.id !== rid) return r;
        const q: Question = {
          id: `q${Date.now()}`, order: r.questions.length, prompt: "", correct: "",
          accepted: [], maxPoints: null,
          mediaSource: r.mediaType === "none" ? "none" : "youtube",
          url: "", clipStart: 0, clipEnd: 15,
        };
        return { ...r, questions: [...r.questions, q] };
      }),
    });

  const delQuestionConfirmed = async (rid: string, qid: string) => {
    const round = quiz.rounds.find((r) => r.id === rid);
    const q = round?.questions.find((x) => x.id === qid);
    const label = q?.prompt?.trim();
    const ok = await confirm({
      title: "Delete this question?",
      body: label ? `"${label.length > 90 ? label.slice(0, 90) + "…" : label}"` : "This question is still empty.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) delQuestion(rid, qid);
  };

  const delQuestion = (rid: string, qid: string) =>
    setQuiz({
      ...quiz,
      rounds: quiz.rounds.map((r) => (r.id !== rid ? r : { ...r, questions: r.questions.filter((q) => q.id !== qid) })),
    });

  const patchTiebreaker = (id: string, patch: Partial<Tiebreaker>) =>
    setQuiz({ ...quiz, tiebreakers: quiz.tiebreakers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const addTiebreaker = () =>
    setQuiz({
      ...quiz,
      tiebreakers: [...quiz.tiebreakers, {
        id: `t${Date.now()}`, order: quiz.tiebreakers.length,
        prompt: "", correct: "", mode: "closest", timeLimit: 30,
      }],
    });

  const delTiebreaker = async (id: string) => {
    const ok = await confirm({
      title: "Delete this tiebreaker?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) setQuiz({ ...quiz, tiebreakers: reindex(quiz.tiebreakers.filter((t) => t.id !== id)) });
  };

  /* `order` is decorative — the server reads array position — but keeping it
     in step avoids nasty surprises if anything ever sorts by it. */
  const reindex = <T extends { order: number }>(items: T[]): T[] =>
    items.map((item, i) => ({ ...item, order: i }));

  const swap = <T,>(items: T[], i: number, dir: -1 | 1): T[] | null => {
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return null;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const moveRound = (id: string, dir: -1 | 1) => {
    const next = swap(quiz.rounds, quiz.rounds.findIndex((r) => r.id === id), dir);
    if (next) setQuiz({ ...quiz, rounds: reindex(next) });
  };

  const delRound = async (id: string) => {
    const r = quiz.rounds.find((x) => x.id === id);
    if (!r) return;
    const n = r.questions.length;
    const ok = await confirm({
      title: `Delete "${r.title || "this round"}"?`,
      body: n > 0
        ? `Its ${n} question${n === 1 ? "" : "s"} will go with it. This can't be undone.`
        : "This round is empty.",
      confirmLabel: "Delete round",
      destructive: true,
    });
    if (ok) setQuiz({ ...quiz, rounds: reindex(quiz.rounds.filter((x) => x.id !== id)) });
  };

  const moveQuestion = (rid: string, qid: string, dir: -1 | 1) =>
    setQuiz({
      ...quiz,
      rounds: quiz.rounds.map((r) => {
        if (r.id !== rid) return r;
        const next = swap(r.questions, r.questions.findIndex((q) => q.id === qid), dir);
        return next ? { ...r, questions: reindex(next) } : r;
      }),
    });

  const moveTiebreaker = (id: string, dir: -1 | 1) => {
    const next = swap(quiz.tiebreakers, quiz.tiebreakers.findIndex((t) => t.id === id), dir);
    if (next) setQuiz({ ...quiz, tiebreakers: reindex(next) });
  };

  const addRound = () =>
    setQuiz({
      ...quiz,
      rounds: [...quiz.rounds, {
        id: `r${Date.now()}`, order: quiz.rounds.length, title: "New round",
        answerFormat: "text", mediaType: "none", timeLimit: 30, defaultMaxPoints: 1, questions: [],
      }],
    });

  const field = { background: C.row, borderColor: C.rule, color: C.ink };

  return (
    <div className="min-h-screen p-3 sm:p-5" style={{ background: C.page, color: C.ink }}>
      {dialog}
      <div className="max-w-4xl mx-auto flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, letterSpacing: "-0.02em" }}>Quiz editor</div>
          <div className="flex gap-2 items-center">
            {saved && <span className="text-xs" style={{ color: C.inkDim }}>saved</span>}
            <Btn small onClick={exportJson}><Download size={13} /> Export</Btn>
            <label>
              <input type="file" accept="application/json" className="hidden"
                onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
              <span className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs cursor-pointer"
                style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
                <Upload size={13} /> Import
              </span>
            </label>
            <Btn tone="primary" onClick={openRoom} disabled={saving}>
              <Play size={14} /> {saving ? "Opening…" : "Open the room"}
            </Btn>
          </div>
        </div>

        {quizzes.length > 1 && (
          <select value={quiz.id} onChange={(e) => setQuiz(quizzes.find((q) => q.id === e.target.value) ?? quiz)}
            className="rounded-md border px-2 py-1.5 text-sm" style={field}>
            {quizzes.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
          </select>
        )}

        <div className="flex items-center gap-3">
          <input value={quiz.title} onChange={(e) => setQuiz({ ...quiz, title: e.target.value })}
            className="flex-1 rounded-md border px-3 py-2 text-lg" style={field} />
          <Btn onClick={addRound}><Plus size={14} /> Round</Btn>
        </div>

        {quiz.rounds.map((r, ri) => (
          <Panel key={r.id} pad={false} title={`Round ${ri + 1}`}
            right={
              <div className="flex items-center gap-1">
                <IconBtn label="Move round up" disabled={ri === 0} onClick={() => moveRound(r.id, -1)}>
                  <ChevronUp size={15} />
                </IconBtn>
                <IconBtn label="Move round down" disabled={ri === quiz.rounds.length - 1} onClick={() => moveRound(r.id, 1)}>
                  <ChevronDown size={15} />
                </IconBtn>
                <button onClick={() => setOpen(open === r.id ? null : r.id)} className="text-xs px-1" style={{ color: C.inkDim }}>
                  {open === r.id ? "Collapse" : "Edit"}
                </button>
                <IconBtn label="Delete round" onClick={() => void delRound(r.id)}>
                  <Trash2 size={14} />
                </IconBtn>
              </div>
            }>
            <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
              {roundIcon(r)}
              <input value={r.title} onChange={(e) => patchRound(r.id, { title: e.target.value })}
                className="flex-1 min-w-32 rounded-md border px-2 py-1.5 text-sm" style={field} />
              <Pill>{r.questions.length} q</Pill>
              <Pill><TimerIcon size={12} />{r.timeLimit}s</Pill>
            </div>

            {open === r.id && (
              <div className="px-3 pb-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <label className="flex flex-col gap-1">
                    <Eyebrow>Answers</Eyebrow>
                    <select value={r.answerFormat} onChange={(e) => patchRound(r.id, { answerFormat: e.target.value as Round["answerFormat"] })}
                      className="rounded-md border px-2 py-1.5 text-sm" style={field}>
                      <option value="text">Open text</option>
                      <option value="yes_no">Yes / No</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <Eyebrow>Media</Eyebrow>
                    <select value={r.mediaType} onChange={(e) => patchRound(r.id, { mediaType: e.target.value as Round["mediaType"] })}
                      className="rounded-md border px-2 py-1.5 text-sm" style={field}>
                      <option value="none">None</option>
                      <option value="audio">Audio</option>
                      <option value="video">Video</option>
                      <option value="image">Image</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <Eyebrow>Seconds</Eyebrow>
                    <input type="number" value={r.timeLimit}
                      onChange={(e) => patchRound(r.id, { timeLimit: Number(e.target.value) || 0 })}
                      className="rounded-md border px-2 py-1.5 text-sm" style={field} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <Eyebrow>Points</Eyebrow>
                    <input type="number" value={r.defaultMaxPoints}
                      onChange={(e) => patchRound(r.id, { defaultMaxPoints: Number(e.target.value) || 1 })}
                      className="rounded-md border px-2 py-1.5 text-sm" style={field} />
                  </label>
                </div>

                <div className="flex flex-col gap-2">
                  {r.questions.map((q, qi) => (
                    <div key={q.id} className="rounded-md p-2" style={{ background: C.row }}>
                      <div className="flex items-start gap-2">
                        <span style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: C.biroDim, minWidth: 22 }}>{qi + 1}</span>
                        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                          <input value={q.prompt} placeholder="Question"
                            onChange={(e) => patchQuestion(r.id, q.id, { prompt: e.target.value })}
                            className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                          <div className="flex gap-1.5">
                            <input value={q.correct} placeholder="Correct answer"
                              onChange={(e) => patchQuestion(r.id, q.id, { correct: e.target.value })}
                              className="flex-1 min-w-0 rounded border px-2 py-1.5 text-sm"
                              style={{ ...field, background: C.card, color: C.correct }} />
                            <input type="number" value={q.maxPoints ?? ""} placeholder={String(r.defaultMaxPoints)}
                              onChange={(e) => patchQuestion(r.id, q.id, { maxPoints: e.target.value === "" ? null : Number(e.target.value) })}
                              className="w-16 rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                          </div>

                          {r.mediaType !== "none" && (
                            <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
                              <div className="flex items-center gap-1.5">
                                <input value={q.url ?? ""} placeholder="Paste a YouTube link"
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    const stamp = parseStamp(v);
                                    patchQuestion(r.id, q.id, stamp != null
                                      ? { url: v, clipStart: stamp, clipEnd: stamp + clipLen(q) }
                                      : { url: v });
                                  }}
                                  className="flex-1 min-w-0 rounded border px-2 py-1.5 text-sm"
                                  style={{ ...field, background: C.page }} />
                                {parseYouTube(q.url) ? <Check size={15} style={{ color: C.correct }} />
                                  : q.url ? <AlertTriangle size={15} style={{ color: C.marker }} /> : null}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs" style={{ color: C.inkDim }}>Play from</span>
                                <input type="number" min={0} value={q.clipStart ?? 0}
                                  onChange={(e) => patchQuestion(r.id, q.id, { clipStart: Math.max(0, Number(e.target.value) || 0) })}
                                  className="w-16 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
                                <span className="text-xs" style={{ color: C.inkDim }}>to</span>
                                <input type="number" min={1} value={q.clipEnd ?? 15}
                                  onChange={(e) => patchQuestion(r.id, q.id, { clipEnd: Math.max(1, Number(e.target.value) || 1) })}
                                  className="w-16 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
                                <span className="text-xs" style={{ color: C.biro, fontFamily: "'DM Mono',monospace" }}>
                                  {clipLen(q)}s clip
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <IconBtn label="Move question up" disabled={qi === 0} onClick={() => moveQuestion(r.id, q.id, -1)}>
                            <ChevronUp size={14} />
                          </IconBtn>
                          <IconBtn label="Move question down" disabled={qi === r.questions.length - 1} onClick={() => moveQuestion(r.id, q.id, 1)}>
                            <ChevronDown size={14} />
                          </IconBtn>
                          <IconBtn label="Delete question" onClick={() => void delQuestionConfirmed(r.id, q.id)}>
                            <Trash2 size={14} />
                          </IconBtn>
                        </div>
                      </div>
                    </div>
                  ))}
                  <Btn small onClick={() => addQuestion(r.id)}><Plus size={13} /> Question</Btn>
                </div>
              </div>
            )}
          </Panel>
        ))}

        <Panel title="Tiebreakers">
          <p className="text-xs mb-3" style={{ color: C.inkDim }}>
            Only used when the top of the leaderboard is tied, and asked in order until
            someone wins.
          </p>

          <div className="flex flex-col gap-2">
            {quiz.tiebreakers.map((t, ti) => (
              <div key={t.id} className="rounded-md p-2" style={{ background: C.row }}>
                <div className="flex items-start gap-2">
                  <span style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: C.biroDim, minWidth: 22 }}>{ti + 1}</span>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    <input value={t.prompt} placeholder="Tiebreaker question"
                      onChange={(e) => patchTiebreaker(t.id, { prompt: e.target.value })}
                      className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                    <div className="flex flex-wrap gap-1.5">
                      <input value={t.correct}
                        placeholder={t.mode === "closest" ? "The number, e.g. 1665" : "Correct answer"}
                        inputMode={t.mode === "closest" ? "numeric" : "text"}
                        onChange={(e) => patchTiebreaker(t.id, { correct: e.target.value })}
                        className="flex-1 min-w-32 rounded border px-2 py-1.5 text-sm"
                        style={{ ...field, background: C.card, color: C.correct }} />
                      <select value={t.mode}
                        onChange={(e) => patchTiebreaker(t.id, { mode: e.target.value as Tiebreaker["mode"] })}
                        className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }}>
                        <option value="closest">Closest wins</option>
                        <option value="exact">Exact answer</option>
                      </select>
                      <input type="number" min={5} value={t.timeLimit}
                        onChange={(e) => patchTiebreaker(t.id, { timeLimit: Math.max(5, Number(e.target.value) || 30) })}
                        className="w-16 rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <IconBtn label="Move up" disabled={ti === 0} onClick={() => moveTiebreaker(t.id, -1)}>
                      <ChevronUp size={14} />
                    </IconBtn>
                    <IconBtn label="Move down" disabled={ti === quiz.tiebreakers.length - 1} onClick={() => moveTiebreaker(t.id, 1)}>
                      <ChevronDown size={14} />
                    </IconBtn>
                    <IconBtn label="Delete tiebreaker" onClick={() => void delTiebreaker(t.id)}>
                      <Trash2 size={14} />
                    </IconBtn>
                  </div>
                </div>
              </div>
            ))}
            <Btn small onClick={addTiebreaker}><Plus size={13} /> Tiebreaker</Btn>
          </div>

          {/* Two exact-answer questions can both come back tied, and then
              you're improvising in front of a room. */}
          {quiz.tiebreakers.length > 0 && quiz.tiebreakers[quiz.tiebreakers.length - 1].mode !== "closest" && (
            <p className="mt-3 text-xs rounded-md px-3 py-2"
              style={{ background: C.warnBg, color: C.ink, border: `1px solid ${C.marker}` }}>
              Your last tiebreaker is an exact answer, so it can tie again and leave you with
              no way to separate the teams. Make it closest-wins.
            </p>
          )}
          {quiz.tiebreakers.length === 0 && (
            <p className="mt-3 text-xs" style={{ color: C.marker }}>
              With no tiebreakers, a tie for first place can't be resolved in the app.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center"
      style={{ background: C.page, color: C.inkDim }}>{children}</div>
  );
}

/** Small square control. Disabled at the ends of a list rather than hidden,
    so the row doesn't reflow as you move things around. */
function IconBtn({ children, onClick, label, disabled }: {
  children: React.ReactNode; onClick: () => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="inline-flex items-center justify-center rounded w-6 h-6"
      style={{ color: C.inkDim, opacity: disabled ? 0.25 : 1, cursor: disabled ? "default" : "pointer" }}>
      {children}
    </button>
  );
}
