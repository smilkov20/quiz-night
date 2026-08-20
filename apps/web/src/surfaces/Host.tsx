import { useEffect, useMemo, useState } from "react";
import {
  Play, RotateCcw, Lock, Unlock, ChevronRight, ChevronLeft, Users, Trophy,
  ClipboardCheck, Eye, Flag, Trash2, AlertTriangle, Check, Timer as TimerIcon,
  Music, Video, Type, ToggleLeft, Image as ImageIcon,
} from "lucide-react";
import {
  answerKey, maxPointsOf, normalise, type Round, type Snapshot,
} from "@quiz/shared";
import { C, FONT_DATA, FONT_DISPLAY } from "../ui/theme";
import { Btn, Countdown, Eyebrow, Leaderboard, Panel, Pill } from "../ui/kit";
import { useQuizSocket } from "../useQuizSocket";
import { YouTubeStage, clipLen, parseYouTube } from "../ui/YouTubeStage";

export const roundIcon = (r: Round) => {
  if (r.mediaType === "audio") return <Music size={14} />;
  if (r.mediaType === "video") return <Video size={14} />;
  if (r.mediaType === "image") return <ImageIcon size={14} />;
  if (r.answerFormat === "yes_no") return <ToggleLeft size={14} />;
  return <Type size={14} />;
};

export function HostSurface({ code, hostKey }: { code: string; hostKey: string }) {
  const { snapshot, status, host, now } = useQuizSocket({ code, role: "host", hostKey });
  const [grading, setGrading] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  if (!snapshot) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: C.page, color: C.inkDim }}>
        {status === "closed" ? "Reconnecting…" : "Connecting…"}
      </div>
    );
  }

  const s = snapshot.session;
  const round = s.quiz.rounds[s.roundIdx];
  const question = round?.questions[s.questionIdx];
  const remaining = s.questionStartedAt && round ? round.timeLimit - (now() - s.questionStartedAt) / 1000 : 0;
  const mediaLeft = s.mediaStartedAt && question ? clipLen(question) - (now() - s.mediaStartedAt) / 1000 : 0;
  const answered = question ? s.teams.filter((t) => s.answers[answerKey(t.id, question.id)]).length : 0;
  const playing = s.phase === "playing_media";
  const canTiebreak = s.tiebreakTeams.length === 0 &&
    snapshot.standings.length > 1 &&
    s.roundIdx === s.quiz.rounds.length - 1 &&
    snapshot.standings[0].score > 0 &&
    snapshot.standings.filter((x) => x.score === snapshot.standings[0].score).length > 1;

  return (
    <div className="min-h-screen p-3 sm:p-5" style={{ background: C.page, color: C.ink }}>
      {/* Confidence monitor: what the room is seeing, without switching tabs. */}
      <YouTubeStage
        question={question ?? null} playing={playing}
        coverPicture={round?.mediaType === "audio"}
        onEnded={() => host({ action: "start_timer" })}
        size={playing ? "monitor" : "hidden"}
      />

      <div className="max-w-7xl mx-auto grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Pill tone={status === "open" ? "live" : "danger"}>{status}</Pill>
            <Pill tone="dim">{s.state.replace("_", " ")}{s.state === "in_round" ? ` · ${s.phase}` : ""}</Pill>
            <span className="ml-auto text-sm" style={{ color: C.inkDim }}>
              Presenter: <code style={{ fontFamily: FONT_DATA }}>/present/{s.joinCode}/{s.presenterToken.slice(0, 8)}…</code>
            </span>
          </div>

          {s.state === "lobby" && (
            <>
              <Panel title="Lobby">
                <div className="flex flex-col sm:flex-row gap-5 items-center">
                  <div className="text-center">
                    <Eyebrow>Join code</Eyebrow>
                    <div style={{ fontFamily: FONT_DATA, fontSize: 42, letterSpacing: "0.12em", color: C.biro, fontWeight: 500 }}>
                      {s.joinCode}
                    </div>
                  </div>
                  <div className="flex-1 w-full">
                    <p className="text-sm mb-3" style={{ color: C.inkDim }}>
                      Teams join at the code above. Start when everyone's in.
                    </p>
                    <Btn tone="primary" onClick={() => host({ action: "begin_round" })} disabled={s.teams.length < 1}>
                      Start round 1 <ChevronRight size={14} />
                    </Btn>
                  </div>
                </div>
              </Panel>
              <SoundCheck snapshot={snapshot} />
            </>
          )}

          {s.state === "in_round" && round && question && (
            <Panel title={`Round ${s.roundIdx + 1} · ${round.title}`}
              right={<Pill tone="biro">Q{s.questionIdx + 1} of {round.questions.length}</Pill>}>
              <div className="flex items-start gap-2 mb-3 flex-wrap">
                <Pill>{roundIcon(round)} {round.mediaType === "none" ? round.answerFormat.replace("_", "/") : round.mediaType}</Pill>
                <Pill><TimerIcon size={12} /> {round.timeLimit}s</Pill>
                <Pill tone="biro">{maxPointsOf(round, question)} pts</Pill>
              </div>

              <p className="mb-1 text-xl" style={{ fontWeight: 600, lineHeight: 1.25 }}>{question.prompt}</p>
              <p className="mb-4 text-sm" style={{ color: C.correct }}>Answer: {question.correct || "—"}</p>

              <div className="flex items-center gap-4 mb-4 flex-wrap">
                {s.phase === "answering" && <Countdown remaining={remaining} total={round.timeLimit} size="sm" />}
                {playing && (
                  <div className="flex-1 min-w-40">
                    <Eyebrow>Clip playing on presenter</Eyebrow>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: C.rule }}>
                      <div className="h-full" style={{
                        width: `${100 - (mediaLeft / clipLen(question)) * 100}%`,
                        background: C.biro, transition: "width 120ms linear",
                      }} />
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.inkDim }}>
                      {question.clipStart}s–{question.clipEnd}s · timer starts when the clip ends
                    </div>
                  </div>
                )}
                <div className="text-sm" style={{ color: C.inkDim }}>
                  {answered} of {s.teams.length} answered
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {s.phase === "idle" && (
                  <Btn tone="primary" onClick={() => host({ action: "reveal_question" })}>
                    <Eye size={14} /> Reveal question
                  </Btn>
                )}
                {s.phase === "revealed" && round.mediaType !== "none" && (
                  <Btn tone="primary" onClick={() => host({ action: "play_media" })}><Play size={14} /> Play clip</Btn>
                )}
                {s.phase === "revealed" && round.mediaType === "none" && (
                  <Btn tone="primary" onClick={() => host({ action: "start_timer" })}><TimerIcon size={14} /> Start timer</Btn>
                )}
                {(playing || (s.phase === "answering" && round.mediaType !== "none")) && (
                  <Btn onClick={() => host({ action: "replay_media" })}><RotateCcw size={14} /> Replay clip</Btn>
                )}
                {playing && <Btn onClick={() => host({ action: "start_timer" })}>Skip to answers</Btn>}
                {s.phase === "answering" && (
                  <>
                    <Btn onClick={() => host({ action: "extend", seconds: 30 })}>+30s</Btn>
                    <Btn tone="danger" onClick={() => host({ action: "lock" })}><Lock size={14} /> Lock now</Btn>
                  </>
                )}
                {s.phase === "locked" && (
                  <>
                    <Btn onClick={() => host({ action: "reopen" })}><Unlock size={14} /> Reopen</Btn>
                    <Btn tone="primary" onClick={() => host({ action: "next_question" })}>
                      {s.questionIdx + 1 < round.questions.length ? "Next question" : "End round"} <ChevronRight size={14} />
                    </Btn>
                  </>
                )}
              </div>
            </Panel>
          )}

          {s.state === "round_review" && (
            <Panel title="Round finished">
              <p className="text-sm mb-4" style={{ color: C.inkDim }}>
                Correct answers are on the big screen and every phone. Nothing needs marking first —
                mark the sheets while the room's still talking.
              </p>
              <div className="flex flex-wrap gap-2">
                <Btn onClick={() => setGrading(true)}>
                  <ClipboardCheck size={14} /> Mark answers
                  {snapshot.ungradedCount > 0 && <span style={{ color: C.marker }}>({snapshot.ungradedCount})</span>}
                </Btn>
                <Btn onClick={() => host({ action: "show_leaderboard" })}><Trophy size={14} /> Show leaderboard</Btn>
                <Btn tone="primary" onClick={() => host({ action: "next_round" })}>
                  {s.roundIdx + 1 < s.quiz.rounds.length ? "Next round" : "Finish quiz"} <ChevronRight size={14} />
                </Btn>
              </div>
            </Panel>
          )}

          {(s.state === "leaderboard" || s.state === "finished") && (
            <Panel title={s.state === "finished" ? "Final scores" : "Standings"}>
              {snapshot.ungradedCount > 0 && (
                <div className="flex items-start gap-2 rounded-md border p-3 mb-3"
                  style={{ borderColor: C.marker, background: C.warnBg }}>
                  <AlertTriangle size={16} style={{ color: C.marker, flexShrink: 0, marginTop: 2 }} />
                  <div className="text-sm">
                    <strong>{snapshot.ungradedCount} answers unmarked.</strong>{" "}
                    <span style={{ color: C.inkDim }}>Those rounds show as provisional rather than scoring zero.</span>
                  </div>
                </div>
              )}
              <Leaderboard standings={snapshot.standings} />
              <div className="flex flex-wrap gap-2 mt-4">
                <Btn onClick={() => setGrading(true)}><ClipboardCheck size={14} /> Mark answers</Btn>
                {canTiebreak && (
                  <Btn tone="danger" onClick={() => host({ action: "run_tiebreaker" })}>
                    <Flag size={14} /> Run tiebreaker
                  </Btn>
                )}
                {s.roundIdx + 1 < s.quiz.rounds.length ? (
                  <Btn tone="primary" onClick={() => host({ action: "next_round" })}>Next round <ChevronRight size={14} /></Btn>
                ) : (
                  <Btn tone="primary" onClick={() => host({ action: "finish" })}><Trophy size={14} /> Declare the winner</Btn>
                )}
              </div>
            </Panel>
          )}

          {s.state === "tiebreaker" && (
            <Panel title="Tiebreaker">
              <p className="text-lg" style={{ fontWeight: 600 }}>{s.quiz.tiebreakers[s.tiebreakIdx]?.prompt}</p>
              <p className="text-sm mt-1 mb-4" style={{ color: C.correct }}>
                Answer: {s.quiz.tiebreakers[s.tiebreakIdx]?.correct}
              </p>
              <div className="flex flex-col gap-2">
                {s.tiebreakTeams.map((id) => {
                  const t = s.teams.find((x) => x.id === id);
                  return (
                    <div key={id} className="flex items-center gap-2 rounded-md px-3 py-2" style={{ background: C.row }}>
                      <span className="flex-1" style={{ fontWeight: 600 }}>{t?.name}</span>
                      <span style={{ color: C.biro, fontWeight: 600 }}>{s.tiebreakAnswers[id] || "—"}</span>
                      <Btn small tone="primary" onClick={() => host({ action: "resolve_tiebreak", teamId: id })}>
                        Winner
                      </Btn>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Panel title={`Teams (${s.teams.length})`}>
            {s.teams.length === 0 && <p className="text-sm" style={{ color: C.inkDim }}>Nobody yet.</p>}
            <ul className="flex flex-col gap-1">
              {s.teams.map((t) => {
                const a = question ? s.answers[answerKey(t.id, question.id)] : null;
                return (
                  <li key={t.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5" style={{ background: C.row }}>
                    <span className="truncate text-sm" style={{ opacity: t.connected ? 1 : 0.5 }}>{t.name}</span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {a ? <Check size={14} style={{ color: C.correct }} /> : <span className="text-xs" style={{ color: C.inkDim }}>—</span>}
                      <button onClick={() => host({ action: "remove_team", teamId: t.id })} title="Remove team" style={{ color: C.inkDim }}>
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Run sheet">
            <ol className="flex flex-col gap-1">
              {s.quiz.rounds.map((r, i) => (
                <li key={r.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
                  style={{
                    background: i === s.roundIdx ? C.high : "transparent",
                    color: i === s.roundIdx ? C.ink : C.inkDim,
                    fontWeight: i === s.roundIdx ? 600 : 400,
                  }}>
                  {roundIcon(r)}
                  <span className="truncate flex-1">{r.title}</span>
                  <span className="text-xs" style={{ fontFamily: FONT_DATA }}>{r.questions.length}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>

      {grading && <Grading snapshot={snapshot} onClose={() => setGrading(false)} onAward={host} />}
    </div>
  );
}

/** Pre-flight. Embedding gets disabled and videos get pulled without warning,
    and you don't want to discover either mid-round. */
function SoundCheck({ snapshot }: { snapshot: Snapshot }) {
  const media = useMemo(
    () => snapshot.session.quiz.rounds
      .filter((r) => r.mediaType !== "none")
      .flatMap((r) => r.questions.map((q) => ({ q, r }))),
    [snapshot.session.quiz]
  );
  if (media.length === 0) return null;
  return (
    <Panel title="Sound check">
      <p className="text-sm mb-3" style={{ color: C.inkDim }}>
        Open each clip before the room fills up.
      </p>
      <ul className="flex flex-col gap-1.5">
        {media.map(({ q, r }) => {
          const id = parseYouTube(q.url);
          return (
            <li key={q.id} className="flex items-center gap-2 rounded px-2 py-1.5" style={{ background: C.row }}>
              {roundIcon(r)}
              <span className="flex-1 truncate text-sm">{r.title} · {q.correct || q.prompt}</span>
              <span className="text-xs" style={{ fontFamily: FONT_DATA, color: C.inkDim }}>
                {q.clipStart}–{q.clipEnd}s
              </span>
              {id ? (
                <a href={`https://www.youtube.com/watch?v=${id}&t=${q.clipStart ?? 0}`} target="_blank" rel="noreferrer"
                  className="text-xs underline" style={{ color: C.biro }}>open</a>
              ) : (
                <span className="text-xs" style={{ color: C.marker }}>no link</span>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** One question at a time, answers clustered by normalised text, so one action
    marks everyone who wrote the same thing. Consistency is the whole point. */
function Grading({ snapshot, onClose, onAward }: {
  snapshot: Snapshot;
  onClose: () => void;
  onAward: (a: { action: "grade"; questionId: string; teamIds: string[]; points: number }) => void;
}) {
  const s = snapshot.session;
  const [roundIdx, setRoundIdx] = useState(s.reviewRound ?? s.roundIdx);
  const round = s.quiz.rounds[roundIdx];

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-0 sm:p-6"
      style={{ background: "rgba(21,35,79,0.42)" }}>
      <div className="w-full max-w-3xl rounded-t-2xl sm:rounded-2xl border flex flex-col"
        style={{ borderColor: C.rule, background: C.page, maxHeight: "92vh" }}>
        <header className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: C.rule }}>
          <Btn small onClick={() => setRoundIdx(Math.max(0, roundIdx - 1))} disabled={roundIdx === 0}>
            <ChevronLeft size={14} />
          </Btn>
          <div className="flex-1 text-center">
            <div className="text-xs uppercase" style={{ color: C.marker, letterSpacing: "0.16em", fontWeight: 700 }}>Marking</div>
            <div style={{ fontWeight: 600 }}>{round.title}</div>
          </div>
          <Btn small onClick={() => setRoundIdx(Math.min(s.quiz.rounds.length - 1, roundIdx + 1))}
            disabled={roundIdx === s.quiz.rounds.length - 1}>
            <ChevronRight size={14} />
          </Btn>
          <Btn small tone="primary" onClick={onClose}>Done</Btn>
        </header>

        <div className="overflow-y-auto p-4 flex flex-col gap-5">
          {round.questions.map((q) => {
            const max = maxPointsOf(round, q);
            const clusters = new Map<string, { display: string; teams: string[]; names: string[]; points: number | null }>();
            for (const t of s.teams) {
              const a = s.answers[answerKey(t.id, q.id)];
              if (!a) continue;
              const key = normalise(a.value) || "(blank)";
              const existing = clusters.get(key);
              if (existing) { existing.teams.push(t.id); existing.names.push(t.name); }
              else clusters.set(key, { display: a.value, teams: [t.id], names: [t.name], points: a.points });
            }
            const list = [...clusters.values()];
            const suggested = (v: string) =>
              normalise(v) === normalise(q.correct) || q.accepted.some((x) => normalise(x) === normalise(v));

            return (
              <div key={q.id}>
                <div className="mb-2">
                  <div className="text-sm" style={{ color: C.inkDim }}>{q.prompt}</div>
                  <div style={{ color: C.correct, fontWeight: 600 }}>{q.correct}</div>
                </div>
                {list.length === 0 && <p className="text-sm" style={{ color: C.inkDim }}>No answers submitted.</p>}
                <div className="flex flex-col gap-2">
                  {list.map((cl, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2"
                      style={{ background: C.card, border: `1px solid ${suggested(cl.display) ? C.correct : C.rule}` }}>
                      <div className="flex-1 min-w-32">
                        <div style={{ fontWeight: 600 }}>{cl.display}</div>
                        <div className="text-xs" style={{ color: C.inkDim }}>{cl.names.join(", ")}</div>
                      </div>
                      <div className="flex gap-1">
                        {Array.from({ length: max + 1 }).map((_, pts) => (
                          <button key={pts}
                            onClick={() => onAward({ action: "grade", questionId: q.id, teamIds: cl.teams, points: pts })}
                            className="w-9 h-9 rounded-full text-sm"
                            style={{
                              background: cl.points === pts ? C.marker : C.card,
                              color: cl.points === pts ? C.onInk : C.inkDim,
                              border: `${cl.points === pts ? 2 : 1}px solid ${cl.points === pts ? C.marker : C.rule}`,
                              fontWeight: 700, fontFamily: FONT_DATA,
                            }}>
                            {pts}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
