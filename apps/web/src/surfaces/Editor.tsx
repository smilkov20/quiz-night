import { useEffect, useState } from "react";
import { Plus, Trash2, Check, AlertTriangle, Timer as TimerIcon, Play, Download, Upload } from "lucide-react";
import type { Quiz, Question, Round } from "@quiz/shared";
import { C, FONT_DISPLAY } from "../ui/theme";
import { Btn, Eyebrow, Panel, Pill } from "../ui/kit";
import { apiFetch } from "../useQuizSocket";
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
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
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

  const delQuestion = (rid: string, qid: string) =>
    setQuiz({
      ...quiz,
      rounds: quiz.rounds.map((r) => (r.id !== rid ? r : { ...r, questions: r.questions.filter((q) => q.id !== qid) })),
    });

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
            right={<button onClick={() => setOpen(open === r.id ? null : r.id)} className="text-xs" style={{ color: C.inkDim }}>
              {open === r.id ? "Collapse" : "Edit"}
            </button>}>
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
                        <button onClick={() => delQuestion(r.id, q.id)} style={{ color: C.inkDim }}><Trash2 size={14} /></button>
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
          <p className="text-xs mb-2" style={{ color: C.inkDim }}>
            Used only when the top of the leaderboard is tied. Keep a closest-wins question last so it can't tie again.
          </p>
          {quiz.tiebreakers.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 mb-1.5" style={{ background: C.row }}>
              <Pill tone={t.mode === "closest" ? "biro" : "dim"}>{t.mode}</Pill>
              <span className="flex-1 truncate text-sm">{t.prompt}</span>
              <span className="text-sm" style={{ color: C.correct }}>{t.correct}</span>
            </div>
          ))}
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
