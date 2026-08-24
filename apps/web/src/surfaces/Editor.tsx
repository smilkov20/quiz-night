import { useEffect, useState } from "react";
import { Plus, Trash2, Check, AlertTriangle, Timer as TimerIcon, Play, Download, Upload, ChevronUp, ChevronDown } from "lucide-react";
import type { Quiz, Question, Round, Tiebreaker, PowerUp, InfoSlide } from "@quiz/shared";
import { POWER_UP_LABELS, describeRound, resolveTheme, DEFAULT_THEME } from "@quiz/shared";
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
  const [scoring, setScoring] = useState<"devices" | "paper">("devices");
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
        "/api/sessions", { method: "POST", body: JSON.stringify({ quiz, scoring }) }, hostKey
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

  const patchSlide = (id: string, patch: Partial<InfoSlide>) =>
    setQuiz({ ...quiz, infoSlides: (quiz.infoSlides ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const patchTheme = (patch: Partial<NonNullable<Quiz["theme"]>>) =>
    setQuiz({ ...quiz, theme: { ...quiz.theme, ...patch } });

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
            <span className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
              style={{ borderColor: C.rule }}
              title="Paper mode: no team phones — the projector runs the quiz and you type the scores in">
              {([["devices", "On phones"], ["paper", "On paper"]] as const).map(([mode, label]) => (
                <button key={mode} onClick={() => setScoring(mode)}
                  className="rounded px-2.5 py-1.5 text-xs whitespace-nowrap"
                  style={{
                    background: scoring === mode ? C.biro : "transparent",
                    color: scoring === mode ? C.onInk : C.inkDim,
                    fontWeight: 600,
                  }}>
                  {label}
                </button>
              ))}
            </span>
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
                      <option value="choice">Multiple choice (A/B/C/D)</option>
                      <option value="fastest">Fastest wins</option>
                      <option value="sort">Sort into categories</option>
                      <option value="order">Put in order</option>
                      <option value="list">Name N of M</option>
                      <option value="match">Match pairs</option>
                      <option value="nominee">Guess your nominee</option>
                      <option value="clues">Progressive clues</option>
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
                  <label className="flex flex-col gap-1"
                    style={{ opacity: r.answerFormat === "fastest" && r.bonusRule === "accuracy" ? 0.4 : 1 }}>
                    <Eyebrow>{r.answerFormat === "fastest" ? "Correct" : "Points"}</Eyebrow>
                    <input type="number" value={r.defaultMaxPoints}
                      onChange={(e) => patchRound(r.id, { defaultMaxPoints: Number(e.target.value) || 1 })}
                      className="rounded-md border px-2 py-1.5 text-sm" style={field} />
                  </label>
                  {r.answerFormat === "fastest" && (
                    <label className="flex flex-col gap-1">
                      <Eyebrow>{(r.bonusRule ?? "speed") === "speed" ? "Fastest" : "Best answer"}</Eyebrow>
                      <input type="number" value={r.fastestPoints ?? r.defaultMaxPoints + 1}
                        onChange={(e) => patchRound(r.id, { fastestPoints: Number(e.target.value) || 1 })}
                        className="rounded-md border px-2 py-1.5 text-sm" style={{ ...field, color: C.biro }} />
                    </label>
                  )}
                </div>

                <div className="mb-3 rounded-md p-2" style={{ background: C.row }}>
                  <Eyebrow>Power-ups teams may spend on this round</Eyebrow>
                  <div className="flex flex-wrap gap-3 mt-1">
                    {(["double", "steal", "hint"] as PowerUp[]).map((p) => (
                      <label key={p} className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox"
                          checked={Boolean(r.allowedPowerUps?.includes(p))}
                          onChange={(e) => patchRound(r.id, {
                            allowedPowerUps: e.target.checked
                              ? [...(r.allowedPowerUps ?? []), p]
                              : (r.allowedPowerUps ?? []).filter((x) => x !== p),
                          })} />
                        {POWER_UP_LABELS[p].name}
                        <span style={{ color: C.inkDim }}>— {POWER_UP_LABELS[p].blurb}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="mb-3 flex flex-wrap gap-4">
                  {r.mediaType !== "none" && r.mediaType !== "image" && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(r.muteMedia)}
                        onChange={(e) => patchRound(r.id, { muteMedia: e.target.checked })} />
                      Play without sound
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(r.explainRound)}
                      onChange={(e) => patchRound(r.id, { explainRound: e.target.checked })} />
                    Explain how this round works before it starts
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(r.rapidFire)}
                      onChange={(e) => patchRound(r.id, { rapidFire: e.target.checked })} />
                    Rapid fire — one clock for the whole round
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(r.wager)}
                      onChange={(e) => patchRound(r.id, { wager: e.target.checked, maxWager: r.maxWager ?? 5 })} />
                    Wager — stake before seeing the question, up to
                    <input type="number" min={1} value={r.maxWager ?? 5} disabled={!r.wager}
                      onChange={(e) => patchRound(r.id, { maxWager: Math.max(1, Number(e.target.value) || 5) })}
                      className="w-14 rounded border px-1 py-0.5 text-sm disabled:opacity-40" style={field} />
                  </label>
                  <label className="flex items-center gap-2 text-sm"
                    title="Only applied to rounds the app marks itself">
                    <input type="checkbox" checked={(r.penaltyForWrong ?? 0) > 0}
                      onChange={(e) => patchRound(r.id, { penaltyForWrong: e.target.checked ? 1 : 0 })} />
                    Wipeout — a wrong answer costs
                    <input type="number" min={1} value={r.penaltyForWrong || 1}
                      disabled={(r.penaltyForWrong ?? 0) === 0}
                      onChange={(e) => patchRound(r.id, { penaltyForWrong: Math.max(1, Number(e.target.value) || 1) })}
                      className="w-14 rounded border px-1 py-0.5 text-sm disabled:opacity-40" style={field} />
                  </label>
                </div>

                {r.explainRound && (
                  <div className="mb-3 rounded-md p-2" style={{ background: C.row }}>
                    <Eyebrow>What the room will be told</Eyebrow>
                    <ul className="text-xs flex flex-col gap-0.5 mb-2" style={{ color: C.ink }}>
                      {describeRound(r).map((line, i) => <li key={i}>· {line}</li>)}
                    </ul>
                    <input value={r.howItWorks ?? ""} placeholder="Anything else to add (optional)"
                      onChange={(e) => patchRound(r.id, { howItWorks: e.target.value })}
                      className="w-full rounded border px-2 py-1 text-sm" style={{ ...field, background: C.card }} />
                    <p className="text-xs mt-1" style={{ color: C.inkDim }}>
                      The rest is generated from this round's settings, so it stays true when you change them.
                    </p>
                  </div>
                )}

                {r.answerFormat === "fastest" && (
                  <div className="mb-3 rounded-md p-2" style={{ background: C.row }}>
                    <Eyebrow>Who gets the higher points</Eyebrow>
                    <select value={r.bonusRule ?? "speed"}
                      onChange={(e) => patchRound(r.id, { bonusRule: e.target.value as "speed" | "accuracy" })}
                      className="w-full rounded-md border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }}>
                      <option value="speed">Only the fastest correct team</option>
                      <option value="accuracy">Everyone with the best answer</option>
                    </select>
                    <p className="text-xs mt-1" style={{ color: C.inkDim }}>
                      {(r.bonusRule ?? "speed") === "speed"
                        ? `Everyone right scores ${r.defaultMaxPoints}; whoever got in first scores ${r.fastestPoints ?? r.defaultMaxPoints + 1} instead.`
                        : `Every team with the best answer scores ${r.fastestPoints ?? r.defaultMaxPoints + 1}, however long they took. Speed is ignored.`}
                    </p>
                  </div>
                )}

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

                          {r.answerFormat === "fastest" && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs" style={{ color: C.inkDim }}>Correct if</span>
                              <select value={q.fastestMode ?? "exact"}
                                onChange={(e) => patchQuestion(r.id, q.id, { fastestMode: e.target.value as "exact" | "closest" })}
                                className="rounded border px-2 py-1 text-sm" style={{ ...field, background: C.card }}>
                                <option value="exact">it matches exactly</option>
                                <option value="closest">it's closest to the number</option>
                              </select>
                            </div>
                          )}

                          {r.answerFormat === "choice" && (
                            <ChoiceEditor question={q} onPatch={(patch) => patchQuestion(r.id, q.id, patch)} field={field} />
                          )}

                          {r.answerFormat === "order" && (
                            <OrderEditor question={q} onPatch={(patch) => patchQuestion(r.id, q.id, patch)} field={field} />
                          )}

                          {r.answerFormat === "sort" && (
                            <SortEditor question={q} onPatch={(patch) => patchQuestion(r.id, q.id, patch)} field={field} />
                          )}

                          {r.answerFormat === "clues" && (
                            <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
                              <Eyebrow>Clues, hardest first</Eyebrow>
                              <textarea rows={4} value={(q.clues ?? []).join("\n")}
                                placeholder={"Born in 1928\nKnown for pop art\nPainted soup cans"}
                                onChange={(e) => patchQuestion(r.id, q.id, { clues: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
                                className="rounded border px-2 py-1.5 text-sm resize-y" style={{ ...field, background: C.page }} />
                              <p className="text-xs" style={{ color: C.inkDim }}>
                                First clue is free. Worth {q.maxPoints ?? r.defaultMaxPoints} after clue one,
                                dropping by one per clue, never below one.
                              </p>
                            </div>
                          )}

                          {r.answerFormat === "choice" && (
                            <label className="flex items-center gap-2 text-xs" style={{ color: C.inkDim }}>
                              <input type="checkbox" checked={Boolean(q.multi)}
                                onChange={(e) => patchQuestion(r.id, q.id, {
                                  multi: e.target.checked,
                                  correctOptions: e.target.checked ? (q.correct ? [q.correct] : []) : undefined,
                                })} />
                              More than one right answer
                            </label>
                          )}

                          {r.answerFormat === "nominee" && (
                            <p className="text-xs rounded px-2 py-1.5" style={{ background: C.row, color: C.inkDim }}>
                              No answer needed — the nominee supplies it live. Write {"{nominee}"}
                              in the question and each team sees their own nominee's name.
                            </p>
                          )}

                          {r.answerFormat === "list" && (
                            <ListEditor question={q} onPatch={(patch) => patchQuestion(r.id, q.id, patch)} field={field} />
                          )}

                          {r.answerFormat === "match" && (
                            <MatchEditor question={q} onPatch={(patch) => patchQuestion(r.id, q.id, patch)} field={field} />
                          )}

                          {r.mediaType === "image" && (
                            <div className="flex flex-col gap-1 rounded p-2" style={{ background: C.card }}>
                              <Eyebrow>Image link</Eyebrow>
                              <input value={q.mediaUrl ?? ""} placeholder="https://…/picture.jpg"
                                onChange={(e) => patchQuestion(r.id, q.id, { mediaUrl: e.target.value, mediaSource: "file" })}
                                className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.page }} />
                              {q.mediaUrl && (
                                <img src={q.mediaUrl} alt="" className="mt-1 rounded"
                                  style={{ maxHeight: 120, objectFit: "contain", border: `1px solid ${C.rule}` }} />
                              )}
                            </div>
                          )}

                          {r.mediaType !== "none" && r.mediaType !== "image" && (
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

        <Panel title="Info pages">
          <p className="text-xs mb-3" style={{ color: C.inkDim }}>
            Pages you can put on the screen at any point — house rules, a sponsor,
            "back in ten". Shown from the host console, not tied to a round.
          </p>
          <div className="flex flex-col gap-2">
            {(quiz.infoSlides ?? []).map((sl, i) => (
              <div key={sl.id} className="rounded-md p-2" style={{ background: C.row }}>
                <div className="flex items-start gap-2">
                  <span style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: C.biroDim, minWidth: 22 }}>{i + 1}</span>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    <input value={sl.title} placeholder="Heading"
                      onChange={(e) => patchSlide(sl.id, { title: e.target.value })}
                      className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                    <textarea rows={2} value={sl.body} placeholder="Body text (optional)"
                      onChange={(e) => patchSlide(sl.id, { body: e.target.value })}
                      className="rounded border px-2 py-1.5 text-sm resize-y" style={{ ...field, background: C.card }} />
                    <input value={sl.imageUrl ?? ""} placeholder="Image link (optional)"
                      onChange={(e) => patchSlide(sl.id, { imageUrl: e.target.value })}
                      className="rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.card }} />
                  </div>
                  <button onClick={() => setQuiz({ ...quiz, infoSlides: (quiz.infoSlides ?? []).filter((x) => x.id !== sl.id) })}
                    style={{ color: C.inkDim }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
            <Btn small onClick={() => setQuiz({ ...quiz, infoSlides: [...(quiz.infoSlides ?? []),
              { id: `i${Date.now()}`, title: "", body: "" }] })}>
              <Plus size={13} /> Page
            </Btn>
          </div>
        </Panel>

        <Panel title="Look and feel">
          <p className="text-xs mb-3" style={{ color: C.inkDim }}>
            Applies to the big screen. The logo also appears on players' phones.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
            {([["page","Background"],["card","Cards"],["ink","Text"],["accent","Accent"],["highlight","Highlighter"]] as const).map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1">
                <Eyebrow>{label}</Eyebrow>
                <div className="flex items-center gap-1.5">
                  <input type="color" value={resolveTheme(quiz.theme)[k]}
                    onChange={(e) => patchTheme({ [k]: e.target.value })}
                    className="rounded border" style={{ width: 34, height: 30, borderColor: C.rule, padding: 0 }} />
                  <input value={quiz.theme?.[k] ?? ""} placeholder={DEFAULT_THEME[k]}
                    onChange={(e) => patchTheme({ [k]: e.target.value })}
                    className="flex-1 min-w-0 rounded border px-2 py-1 text-sm" style={field} />
                </div>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <Eyebrow>Logo link</Eyebrow>
              <input value={quiz.theme?.logoUrl ?? ""} placeholder="https://…/logo.png"
                onChange={(e) => patchTheme({ logoUrl: e.target.value })}
                className="rounded border px-2 py-1.5 text-sm" style={field} />
            </label>
            <label className="flex flex-col gap-1">
              <Eyebrow>Footer line</Eyebrow>
              <input value={quiz.theme?.footer ?? ""} placeholder="The Crown & Anchor · Thursdays"
                onChange={(e) => patchTheme({ footer: e.target.value })}
                className="rounded border px-2 py-1.5 text-sm" style={field} />
            </label>
          </div>

          <div className="mt-4 rounded-lg p-5 text-center relative overflow-hidden"
            style={{ background: resolveTheme(quiz.theme).page, border: `1px solid ${C.rule}` }}>
            {quiz.theme?.logoUrl && (
              <img src={quiz.theme.logoUrl} alt="" className="absolute"
                style={{ top: 10, left: 12, maxHeight: 26, maxWidth: 90, objectFit: "contain" }} />
            )}
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, color: resolveTheme(quiz.theme).ink, letterSpacing: "-0.02em" }}>
              <span style={{ background: resolveTheme(quiz.theme).highlight, padding: "0.02em 0.18em" }}>Round 1</span>
            </div>
            <div className="mt-3 mx-auto rounded-lg px-3 py-2 text-sm" style={{
              background: resolveTheme(quiz.theme).card, color: resolveTheme(quiz.theme).ink, maxWidth: 260 }}>
              A question would look like this
            </div>
            {quiz.theme?.footer && (
              <div className="absolute text-xs" style={{ bottom: 8, right: 12, color: resolveTheme(quiz.theme).ink, opacity: 0.55 }}>
                {quiz.theme.footer}
              </div>
            )}
          </div>
        </Panel>

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

/** The pool is the full answer set; requiredCount is how many to ask for. */
function ListEditor({ question, onPatch, field }: {
  question: Question;
  onPatch: (patch: Partial<Question>) => void;
  field: React.CSSProperties;
}) {
  const pool = question.listAnswers ?? [];
  const asked = question.requiredCount ?? pool.length;
  return (
    <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
      <Eyebrow>Every acceptable answer, one per line</Eyebrow>
      <textarea rows={4} value={pool.join("\n")}
        placeholder={"Kenya\nUganda\nTanzania"}
        onChange={(e) => onPatch({ listAnswers: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
        className="rounded border px-2 py-1.5 text-sm resize-y" style={{ ...field, background: C.page }} />
      <div className="flex items-center gap-1.5">
        <span className="text-xs" style={{ color: C.inkDim }}>Ask teams to name</span>
        <input type="number" min={1} max={Math.max(1, pool.length)} value={asked}
          onChange={(e) => onPatch({ requiredCount: Math.max(1, Number(e.target.value) || 1) })}
          className="w-16 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
        <span className="text-xs" style={{ color: C.inkDim }}>of {pool.length}</span>
      </div>
      {asked > pool.length && pool.length > 0 && (
        <p className="text-xs" style={{ color: C.marker }}>
          You're asking for more than you've listed.
        </p>
      )}
    </div>
  );
}

/** Left items keep their order; right items are shuffled for teams. */
function MatchEditor({ question, onPatch, field }: {
  question: Question;
  onPatch: (patch: Partial<Question>) => void;
  field: React.CSSProperties;
}) {
  const pairs = question.pairs ?? [];
  const set = (i: number, patch: Partial<{ left: string; right: string }>) =>
    onPatch({ pairs: pairs.map((p, n) => (n === i ? { ...p, ...patch } : p)) });
  return (
    <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
      <Eyebrow>Pairs</Eyebrow>
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={p.left} placeholder="e.g. Orwell"
            onChange={(e) => set(i, { left: e.target.value })}
            className="flex-1 min-w-0 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
          <span style={{ color: C.inkDim }}>→</span>
          <input value={p.right} placeholder="e.g. 1984"
            onChange={(e) => set(i, { right: e.target.value })}
            className="flex-1 min-w-0 rounded border px-2 py-1 text-sm"
            style={{ ...field, background: C.page, color: C.correct }} />
          <button onClick={() => onPatch({ pairs: pairs.filter((_, n) => n !== i) })}
            style={{ color: C.inkDim }}><Trash2 size={13} /></button>
        </div>
      ))}
      <button onClick={() => onPatch({ pairs: [...pairs, { left: "", right: "" }] })}
        className="self-start rounded border px-2 py-1 text-xs"
        style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
        + Pair
      </button>
      <p className="text-xs" style={{ color: C.inkDim }}>
        Teams see the right-hand side shuffled. One point per correct pair.
      </p>
    </div>
  );
}

/** Options keep their order for everyone — the host reads them out as A, B,
    C, D, so shuffling per team would make the round impossible to run. */
function ChoiceEditor({ question, onPatch, field }: {
  question: Question;
  onPatch: (patch: Partial<Question>) => void;
  field: React.CSSProperties;
}) {
  const options = question.options ?? [];
  const set = (i: number, v: string) => {
    const next = options.map((x, n) => (n === i ? v : x));
    // Keep `correct` pointing at the same option as it's renamed.
    const patch: Partial<Question> = { options: next };
    if (question.correct === options[i]) patch.correct = v;
    onPatch(patch);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
      <Eyebrow>Options — tick the right one</Eyebrow>
      {options.map((opt, i) => {
        const isCorrect = opt !== "" && (question.multi
          ? (question.correctOptions ?? []).includes(opt)
          : question.correct === opt);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <button
              onClick={() => {
                if (!question.multi) return onPatch({ correct: opt });
                const set = question.correctOptions ?? [];
                onPatch({ correctOptions: set.includes(opt) ? set.filter((x) => x !== opt) : [...set, opt] });
              }}
              title={question.multi ? "Toggle as a correct answer" : "Mark as correct"}
              className="inline-flex items-center justify-center rounded-full shrink-0"
              style={{
                width: 26, height: 26,
                background: isCorrect ? C.correct : C.row,
                color: isCorrect ? C.onInk : C.inkDim,
                fontFamily: FONT_DISPLAY, fontSize: 14,
              }}>
              {String.fromCharCode(65 + i)}
            </button>
            <input value={opt} placeholder={`Option ${String.fromCharCode(65 + i)}`}
              onChange={(e) => set(i, e.target.value)}
              className="flex-1 min-w-0 rounded border px-2 py-1 text-sm"
              style={{ ...field, background: C.page, color: isCorrect ? C.correct : C.ink }} />
            <button onClick={() => onPatch({ options: options.filter((_, n) => n !== i) })}
              style={{ color: C.inkDim }}><Trash2 size={13} /></button>
          </div>
        );
      })}
      <button onClick={() => onPatch({ options: [...options, ""] })}
        disabled={options.length >= 6}
        className="self-start rounded border px-2 py-1 text-xs disabled:opacity-40"
        style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
        + Option
      </button>
      {options.length > 0 && (question.multi
        ? (question.correctOptions ?? []).length === 0
        : !options.includes(question.correct)) && (
        <p className="text-xs" style={{ color: C.marker }}>
          {question.multi ? "Tick at least one correct option." : "No option is marked correct — tap a letter."}
        </p>
      )}
    </div>
  );
}

/** The list is stored in its correct order; teams always see it shuffled. */
function OrderEditor({ question, onPatch, field }: {
  question: Question;
  onPatch: (patch: Partial<Question>) => void;
  field: React.CSSProperties;
}) {
  const seq = question.sequence ?? [];
  const set = (i: number, v: string) => onPatch({ sequence: seq.map((x, n) => (n === i ? v : x)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= seq.length) return;
    const next = [...seq];
    [next[i], next[j]] = [next[j], next[i]];
    onPatch({ sequence: next });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
      <Eyebrow>Correct order, first to last</Eyebrow>
      {seq.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: C.biroDim, minWidth: 18 }}>{i + 1}</span>
          <input value={item} placeholder="Item"
            onChange={(e) => set(i, e.target.value)}
            className="flex-1 min-w-0 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
          <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up"
            style={{ color: C.inkDim, opacity: i === 0 ? 0.25 : 1 }}><ChevronUp size={14} /></button>
          <button onClick={() => move(i, 1)} disabled={i === seq.length - 1} title="Move down"
            style={{ color: C.inkDim, opacity: i === seq.length - 1 ? 0.25 : 1 }}><ChevronDown size={14} /></button>
          <button onClick={() => onPatch({ sequence: seq.filter((_, n) => n !== i) })}
            style={{ color: C.inkDim }}><Trash2 size={13} /></button>
        </div>
      ))}
      <button onClick={() => onPatch({ sequence: [...seq, ""] })}
        className="self-start rounded border px-2 py-1 text-xs"
        style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
        + Item
      </button>
      <p className="text-xs" style={{ color: C.inkDim }}>
        Teams see these shuffled. One point per item in the right place.
      </p>
    </div>
  );
}

/** Categories as a comma-separated line, because typing three words is faster
    than three separate add-a-field interactions. */
function SortEditor({ question, onPatch, field }: {
  question: Question;
  onPatch: (patch: Partial<Question>) => void;
  field: React.CSSProperties;
}) {
  const categories = question.categories ?? [];
  const items = question.items ?? [];

  const setCategories = (raw: string) => {
    const next = raw.split(",").map((c) => c.trim()).filter(Boolean);
    // Any word filed under a category that no longer exists loses its home.
    const cleaned = items.map((it) => (next.includes(it.category) ? it : { ...it, category: next[0] ?? "" }));
    onPatch({ categories: next, items: cleaned });
  };

  const setItem = (i: number, patch: Partial<{ word: string; category: string }>) =>
    onPatch({ items: items.map((it, n) => (n === i ? { ...it, ...patch } : it)) });

  return (
    <div className="flex flex-col gap-1.5 rounded p-2" style={{ background: C.card }}>
      <div>
        <Eyebrow>Groups to sort into</Eyebrow>
        <input
          value={categories.join(", ")}
          placeholder="Fruit, Vegetable, Nut"
          onChange={(e) => setCategories(e.target.value)}
          className="w-full rounded border px-2 py-1.5 text-sm" style={{ ...field, background: C.page }} />
        <p className="text-xs mt-1" style={{ color: C.inkDim }}>
          Comma separated. These are the buckets, not the words.
        </p>
      </div>

      {categories.length === 1 && (
        <p className="text-xs rounded px-2 py-1.5"
          style={{ background: C.warnBg, color: C.ink, border: `1px solid ${C.marker}` }}>
          One group means every word has the same answer and there's nothing to sort.
          Add at least two.
        </p>
      )}

      {items.length > 0 && <Eyebrow>Words, and where each belongs</Eyebrow>}

      {items.map((it, i) => (
        <div key={i} className="flex gap-1.5">
          <input value={it.word} placeholder="Word"
            onChange={(e) => setItem(i, { word: e.target.value })}
            className="flex-1 min-w-0 rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page }} />
          <select value={it.category} onChange={(e) => setItem(i, { category: e.target.value })}
            className="rounded border px-2 py-1 text-sm" style={{ ...field, background: C.page, color: C.correct }}>
            {categories.length === 0 && <option value="">Add categories first</option>}
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => onPatch({ items: items.filter((_, n) => n !== i) })}
            style={{ color: C.inkDim }}><Trash2 size={13} /></button>
        </div>
      ))}

      <button
        onClick={() => onPatch({ items: [...items, { word: "", category: categories[0] ?? "" }] })}
        disabled={categories.length === 0}
        className="self-start rounded border px-2 py-1 text-xs disabled:opacity-40"
        style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
        + Word
      </button>

      <p className="text-xs" style={{ color: C.inkDim }}>
        {items.length === 0
          ? "No words yet."
          : `${items.length} word${items.length === 1 ? "" : "s"} to file across ${categories.length} group${categories.length === 1 ? "" : "s"}, marked automatically.`}
      </p>
    </div>
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
