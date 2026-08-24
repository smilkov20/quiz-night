import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, RotateCcw, Lock, Unlock, ChevronRight, ChevronLeft, Users, Trophy,
  ClipboardCheck, Eye, Flag, Trash2, AlertTriangle, Check, Timer as TimerIcon,
  Music, Video, Type, ToggleLeft, Image as ImageIcon, Monitor, Copy, Coffee, Power,
  Download, RefreshCw, Ban, Presentation, Pencil, Smartphone, EyeOff,
} from "lucide-react";
import {
  answerKey, maxPointsOf, normalise, scoreSort, scoreOrder, scoreList, scoreMatch,
  scoreMulti, parseListAnswer, describeAnswer, type Round, type Snapshot,
  type InfoSlide,
} from "@quiz/shared";
import { C, FONT_DATA, FONT_DISPLAY } from "../ui/theme";
import { Btn, Countdown, Eyebrow, Leaderboard, Panel, Pill, useToasts, useConfirm } from "../ui/kit";
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
  const { snapshot, status, fatal, host, now } = useQuizSocket({ code, role: "host", hostKey });
  const [grading, setGrading] = useState(false);
  const { push, toasts } = useToasts();
  const { confirm, dialog } = useConfirm();
  const [hideAnswers, setHideAnswers] = useState(false);

  /* Ends the session for everyone: phones and the projector are disconnected
     and shown the join screen, rather than sitting on a stale leaderboard. */
  const removeTeam = async (teamId: string, name: string) => {
    const ok = await confirm({
      title: `Remove "${name}"?`,
      body: "Their answers and score go with them. They'd have to rejoin as a new team.",
      confirmLabel: "Remove", destructive: true,
    });
    if (ok) host({ action: "remove_team", teamId });
  };

  /* Sessions live in memory, and a free instance can restart without warning.
     This is the paper backup: if the server dies you can still finish. */
  const downloadScores = () => {
    const s2 = snapshot!.session;
    const rows = snapshot!.standings.map((t) => ({
      rank: t.rank, team: t.name, total: t.score,
      byRound: s2.quiz.rounds.map((r, i) => ({
        round: r.title,
        points: r.questions.reduce((n, q) => n + (s2.answers[answerKey(t.teamId, q.id)]?.points ?? 0), 0),
        doubled: s2.teams.find((x) => x.id === t.teamId)?.jokerRound === i,
      })),
    }));
    const blob = new Blob([JSON.stringify({
      quiz: s2.quiz.title, joinCode: s2.joinCode, savedAt: new Date().toISOString(), standings: rows,
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scores-${s2.joinCode}-${new Date().toISOString().slice(11, 16).replace(":", "")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    push({ title: "Scores saved", body: "Keep it — a restart would lose the session." });
  };

  const closeRoom = async () => {
    const ok = await confirm({
      title: "Close the room?",
      body: "Every phone and the big screen will be disconnected and asked to join a new quiz. Scores are not kept.",
      confirmLabel: "Close the room",
      destructive: true,
    });
    if (ok) host({ action: "close_room" });
  };
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  const prevPhase = useRef<string | null>(null);
  const notifiedAllIn = useRef<string | null>(null);
  useEffect(() => {
    const s = snapshot?.session;
    if (!s) return;
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];

    if (prevPhase.current === "answering" && s.phase === "locked" && q) {
      const more = s.questionIdx + 1 < (round?.questions.length ?? 0);
      push({
        title: "Time's up — answers locked",
        body: more ? "Read out the answer, then hit Next question." : "That's the round. Reveal the answers when you're ready.",
        tone: "alert",
      });
    }

    if (s.phase === "answering" && q && s.teams.length > 0) {
      const answered = s.teams.filter((t) => s.answers[answerKey(t.id, q.id)]).length;
      if (answered === s.teams.length && notifiedAllIn.current !== q.id) {
        notifiedAllIn.current = q.id;
        push({ title: "All teams have answered", body: "You can lock early rather than wait out the clock." });
      }
    }
    prevPhase.current = s.phase;
  }, [snapshot?.session.phase, snapshot?.session.answers, push]);

  if (fatal) {
    return (
      <Fatal
        title={fatal === "no-room" ? "That room has ended" : "Sign-in rejected"}
        detail={fatal === "no-room"
          ? "The server restarted or the room was reaped. Open a new room to carry on."
          : "The host password wasn't accepted. Sign in again."}
        action={fatal === "unauthorised" ? "Sign in again" : "Back to the editor"}
        onAction={() => {
          if (fatal === "unauthorised") sessionStorage.removeItem("quiz.host.key");
          window.location.assign("/host");
        }}
      />
    );
  }

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
        size={playing ? "monitor" : "hidden"}
        muted
      />

      <div className="max-w-7xl mx-auto grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Pill tone={status === "open" ? "live" : "danger"}>{status}</Pill>
            <Pill tone="dim">{s.state.replace("_", " ")}{s.state === "in_round" ? ` · ${s.phase}` : ""}</Pill>
            <span className="ml-auto flex items-center gap-2">
              <InfoSlides slides={s.quiz.infoSlides ?? []} showing={s.state === "info"}
                onShow={(id) => host({ action: "show_info", slideId: id })}
                onHide={() => host({ action: "hide_info" })} />
              <Btn small onClick={downloadScores} title="Save the scores in case the server restarts">
                <Download size={13} /> Scores
              </Btn>
              <PresenterControls session={s} compact />
            </span>
          </div>

          {s.state === "lobby" && s.scoring === "paper" && (
            <Panel title="Teams">
              <p className="text-sm mb-3" style={{ color: C.inkDim }}>
                Nobody joins on a phone. Type the team names in as they arrive, then
                run the quiz from the big screen and mark their paper between rounds.
              </p>
              <AddTeam onAdd={(name) => host({ action: "add_team", name })} />
              <div className="flex flex-wrap gap-1.5 mt-3">
                {s.teams.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm"
                    style={{ background: C.row, border: `1px solid ${C.rule}`, fontWeight: 600 }}>
                    {t.name}
                    <button onClick={() => host({ action: "remove_team", teamId: t.id })}
                      style={{ color: C.inkDim }}><Trash2 size={12} /></button>
                  </span>
                ))}
              </div>
              <div className="mt-4">
                <Btn tone="primary" onClick={() => host({ action: "begin_round" })} disabled={s.teams.length < 1}>
                  Start round 1 <ChevronRight size={14} />
                </Btn>
              </div>
            </Panel>
          )}

          {s.state === "lobby" && s.scoring === "devices" && (
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
                      Teams join at the code above. Open the presenter view on your
                      second screen before you start.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <PresenterControls session={s} />
                      <Btn onClick={() => host({ action: "begin_round" })} disabled={s.teams.length < 1}>
                        Start round 1 <ChevronRight size={14} />
                      </Btn>
                    </div>
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

              {round.answerFormat === "clues" && (
                <ol className="mb-4 flex flex-col gap-1">
                  {(question.clues ?? []).map((clue, i) => (
                    <li key={i} className="rounded px-2 py-1 text-sm"
                      style={{
                        background: i < s.cluesShown ? C.high : C.row,
                        color: i < s.cluesShown ? C.ink : C.inkDim,
                      }}>
                      {i + 1}. {clue}{i >= s.cluesShown ? " (not shown yet)" : ""}
                    </li>
                  ))}
                </ol>
              )}

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
                  {s.scoring === "paper"
                    ? "Teams are answering on paper"
                    : round.wager && s.phase === "revealed"
                    ? `${s.teams.filter((t) => s.wagers?.[answerKey(t.id, question.id)] != null).length} of ${s.teams.length} staked`
                    : `${answered} of ${s.teams.length} answered`}
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
                  <Btn tone="primary" onClick={() => host({ action: "start_timer" })}>
                    <TimerIcon size={14} /> {round.wager ? "Stakes in — show the question" : "Start timer"}
                  </Btn>
                )}
                {round.answerFormat === "clues" && s.phase === "answering" &&
                  s.cluesShown < (question.clues?.length ?? 0) && (
                  <Btn onClick={() => host({ action: "reveal_clue" })}>
                    Next clue ({s.cluesShown} of {question.clues?.length})
                  </Btn>
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
                    <Btn onClick={async () => {
                      const ok = await confirm({
                        title: "Void this question?",
                        body: "Nobody scores on it and any stakes are returned. Use it when a question turns out to be wrong or ambiguous.",
                        confirmLabel: "Void it", destructive: true,
                      });
                      if (ok) host({ action: "void_question", questionId: question.id });
                    }}><Ban size={14} /> Void</Btn>
                    <Btn tone="primary" onClick={() => host({ action: "next_question" })}>
                      {s.questionIdx + 1 < round.questions.length ? "Next question" : "End round"} <ChevronRight size={14} />
                    </Btn>
                  </>
                )}
              </div>
            </Panel>
          )}

          {s.state === "break" && (
            <Panel title="Break">
              <div className="flex flex-col sm:flex-row items-center gap-5">
                <Countdown
                  remaining={s.breakEndsAt ? (s.breakEndsAt - now()) / 1000 : 0}
                  total={Math.max(1, ((s.breakEndsAt ?? 0) - (s.breakStartedAt ?? 0)) / 1000)}
                  size="md"
                />
                <div className="flex-1 w-full">
                  <p className="text-sm mb-3" style={{ color: C.inkDim }}>
                    Teams and the big screen are showing the countdown. Mark answers now —
                    the break won't end on its own.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {s.scoring === "devices" && (
                      <Btn onClick={() => setGrading(true)}>
                        <ClipboardCheck size={14} /> Mark answers
                        {snapshot.ungradedCount > 0 && <span style={{ color: C.marker }}>({snapshot.ungradedCount})</span>}
                      </Btn>
                    )}
                    <Btn onClick={() => host({ action: "extend_break", minutes: 5 })}>+5 min</Btn>
                    <Btn tone="primary" onClick={() => host({ action: "end_break" })}>
                      Back to the quiz <ChevronRight size={14} />
                    </Btn>
                  </div>
                </div>
              </div>
            </Panel>
          )}

          {s.scoring === "paper" && s.state !== "lobby" && (
            <Panel title="Scores"
              right={<Pill tone="dim">enter points per round</Pill>}>
              <div className="overflow-x-auto">
                <table className="text-sm" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
                  <thead>
                    <tr>
                      <th className="text-left px-2 py-1.5" style={{ color: C.inkDim, fontWeight: 700 }}>Team</th>
                      {s.quiz.rounds.map((r, i) => (
                        <th key={r.id} className="px-1 py-1.5 text-center"
                          style={{ color: i === s.roundIdx ? C.biro : C.inkDim, fontWeight: 700, minWidth: 46 }}
                          title={r.title}>
                          {i + 1}
                        </th>
                      ))}
                      <th className="px-2 py-1.5 text-right" style={{ color: C.inkDim, fontWeight: 700 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.teams.map((t) => (
                      <tr key={t.id} style={{ borderTop: `1px solid ${C.rule}` }}>
                        <td className="px-2 py-1.5 truncate" style={{ fontWeight: 600, maxWidth: 160 }}>{t.name}</td>
                        {s.quiz.rounds.map((r, i) => (
                          <td key={r.id} className="px-1 py-1">
                            <input
                              type="number" inputMode="numeric"
                              value={s.manualScores?.[`${t.id}:${i}`] ?? ""}
                              placeholder="–"
                              onChange={(e) => host({
                                action: "set_manual_score", teamId: t.id, roundIdx: i,
                                points: Math.round(Number(e.target.value) || 0),
                              })}
                              className="w-12 rounded border px-1 py-1 text-center"
                              style={{
                                background: i === s.roundIdx ? C.card : C.row,
                                borderColor: i === s.roundIdx ? C.biro : C.rule,
                                color: C.ink,
                              }} />
                          </td>
                        ))}
                        <td className="px-2 py-1.5 text-right"
                          style={{ fontFamily: FONT_DATA, fontWeight: 700, color: C.biro }}>
                          {snapshot.standings.find((x) => x.teamId === t.id)?.score ?? 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <AddTeam onAdd={(name) => host({ action: "add_team", name })} compact />
                <span className="text-xs" style={{ color: C.inkDim }}>
                  Round {s.roundIdx + 1} is highlighted. Leave a cell blank for nothing scored.
                </span>
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
                {s.scoring === "devices" && (
                  <Btn onClick={() => setGrading(true)}>
                    <ClipboardCheck size={14} /> Mark answers
                    {snapshot.ungradedCount > 0 && <span style={{ color: C.marker }}>({snapshot.ungradedCount})</span>}
                  </Btn>
                )}
                <Btn onClick={() => host({ action: "show_leaderboard" })}><Trophy size={14} /> Show leaderboard</Btn>
                <BreakButton onBreak={(m) => host({ action: "start_break", minutes: m })} />
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
                {s.scoring === "devices" && (
                  <Btn onClick={() => setGrading(true)}><ClipboardCheck size={14} /> Mark answers</Btn>
                )}
                <BreakButton onBreak={(m) => host({ action: "start_break", minutes: m })} />
                {s.state === "finished" && (
                  <Btn tone="danger" onClick={() => void closeRoom()}>
                    <Power size={14} /> Close the room
                  </Btn>
                )}
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
              {s.tiebreakIdx + 1 < s.quiz.tiebreakers.length && (
                <div className="mt-3">
                  <Btn onClick={() => host({ action: "next_tiebreaker" })}>
                    Still tied — next tiebreaker
                  </Btn>
                </div>
              )}
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
                    <span className="truncate text-sm" style={{ opacity: t.connected ? 1 : 0.5 }}>
                      {t.name}
                      {t.nomineeName && (
                        <span className="ml-1.5 text-xs" style={{ color: C.inkDim }}
                          title={`Nominee: ${t.nomineeName}`}>
                          · {t.nomineeName}
                        </span>
                      )}
                      {t.jokerRound != null && (
                        <span className="ml-1.5 rounded px-1 text-xs"
                          style={{ background: C.high, color: C.ink, fontWeight: 700 }}
                          title={`Joker on round ${t.jokerRound + 1}`}>
                          J{t.jokerRound + 1}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {a ? <Check size={14} style={{ color: C.correct }} /> : <span className="text-xs" style={{ color: C.inkDim }}>—</span>}
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Re-link ${t.name}?`,
                            body: "Their phone has died or lost its data. Releasing the name lets a replacement device join with the same team name and keep the score.",
                            confirmLabel: "Release the name",
                          });
                          if (ok) host({ action: "relink_team", teamId: t.id });
                        }}
                        title="Re-link a dead phone" style={{ color: t.awaitingRelink ? C.marker : C.inkDim }}>
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${t.name}?`,
                          body: "Their answers and score go with them.",
                          confirmLabel: "Remove", destructive: true,
                        });
                        if (ok) host({ action: "remove_team", teamId: t.id });
                      }} title="Remove team" style={{ color: C.inkDim }}>
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
      {dialog}
      {toasts}
    </div>
  );
}

/** Three durations rather than a free-text field — you're standing in front
    of a room, not filling in a form. */
function BreakButton({ onBreak }: { onBreak: (minutes: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <Btn onClick={() => setOpen(true)}><Coffee size={14} /> Take a break</Btn>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      {[5, 10, 15].map((m) => (
        <Btn key={m} small tone="primary" onClick={() => { onBreak(m); setOpen(false); }}>{m} min</Btn>
      ))}
      <Btn small onClick={() => setOpen(false)}>Cancel</Btn>
    </span>
  );
}

/** Sessions live in memory, and a free instance can restart without warning.
    One click turns that from a disaster into an annoyance. */
function downloadScores(snapshot: Snapshot) {
  const s = snapshot.session;
  const header = ["Team", ...s.quiz.rounds.map((r) => r.title), "Total"];
  const rows = snapshot.standings.map((st) => {
    const team = s.teams.find((t) => t.id === st.teamId);
    const perRound = s.quiz.rounds.map((round, ri) => {
      let n = 0;
      for (const q of round.questions) {
        const a = s.answers[`${st.teamId}:${q.id}`];
        if (a?.points != null) n += a.points;
      }
      return team?.jokerRound === ri ? n * 2 : n;
    });
    return [st.name, ...perRound, st.score];
  });
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `quiz-${s.joinCode}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function AddTeam({ onAdd, compact }: { onAdd: (name: string) => void; compact?: boolean }) {
  const [name, setName] = useState("");
  const submit = () => { if (name.trim()) { onAdd(name.trim()); setName(""); } };
  return (
    <span className="inline-flex items-center gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="Team name" maxLength={60}
        className="rounded-md border px-2 py-1.5 text-sm"
        style={{ background: C.card, borderColor: C.rule, color: C.ink, width: compact ? 150 : 220 }} />
      <Btn small onClick={submit} disabled={!name.trim()}><Users size={13} /> Add</Btn>
    </span>
  );
}

function InfoSlides({ slides, showing, onShow, onHide }: {
  slides: InfoSlide[]; showing: boolean;
  onShow: (id: string) => void; onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (slides.length === 0) return null;
  if (showing) {
    return <Btn small tone="danger" onClick={onHide}><Presentation size={13} /> Back to the quiz</Btn>;
  }
  if (!open) {
    return <Btn small onClick={() => setOpen(true)}><Presentation size={13} /> Show a page</Btn>;
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {slides.map((sl) => (
        <Btn key={sl.id} small tone="primary" onClick={() => { onShow(sl.id); setOpen(false); }}>
          {sl.title || "Untitled"}
        </Btn>
      ))}
      <Btn small onClick={() => setOpen(false)}>Cancel</Btn>
    </span>
  );
}

function PresenterControls({ session, compact }: { session: Snapshot["session"]; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/present/${session.joinCode}/${session.presenterToken}`;

  /* Named window, so pressing this again focuses the projector view you
     already have rather than opening a second one. Drag it to the TV. */
  const openPresenter = () =>
    window.open(url, "quiz-presenter", "popup=yes,width=1280,height=720");

  const copyLink = () =>
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      // Clipboard access needs HTTPS; prompt() still lets them copy by hand.
      () => window.prompt("Copy the presenter link:", url)
    ) ?? window.prompt("Copy the presenter link:", url);

  return (
    <div className="flex items-center gap-2">
      <Btn small={compact} tone="primary" onClick={openPresenter}>
        <Monitor size={14} /> Open presenter
      </Btn>
      <Btn small={compact} onClick={copyLink} title="For opening on a separate device">
        {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy link</>}
      </Btn>
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
            const clusters = new Map<string, { display: string; teams: string[]; names: string[]; points: number | null; sub?: string }>();
            for (const t of s.teams) {
              const a = s.answers[answerKey(t.id, q.id)];
              if (!a) continue;
              // A sort answer is JSON, and a speed answer's timing is the
              // whole story — neither reads well as a raw string.
              let display = a.value;
              let sub: string | undefined;
              if (round.answerFormat === "sort") {
                const { correct, total } = scoreSort(a.value, q);
                display = `${correct} of ${total} filed correctly`;
              } else if (round.answerFormat === "order") {
                const { correct, total } = scoreOrder(a.value, q);
                display = `${correct} of ${total} in the right place`;
              } else if (round.answerFormat === "list") {
                const { correct, total } = scoreList(a.value, q);
                display = parseListAnswer(a.value).filter(Boolean).join(", ") || "(blank)";
                sub = `${correct} of ${total} correct`;
              } else if (round.answerFormat === "match") {
                const { correct, total } = scoreMatch(a.value, q);
                display = `${correct} of ${total} paired correctly`;
              } else if (round.answerFormat === "choice" && q.multi) {
                const { correct, total } = scoreMulti(a.value, q);
                display = parseListAnswer(a.value).join(", ") || "(nothing ticked)";
                sub = `nets ${correct} of ${total}`;
              } else if (round.answerFormat === "clues") {
                sub = `answered on clue ${a.atClue ?? 1}`;
              } else if (round.answerFormat === "nominee") {
                const said = s.nomineeAnswers?.[answerKey(t.id, q.id)]?.value;
                sub = said ? `nominee said "${said}"` : "nominee didn't answer";
              } else if (round.answerFormat === "fastest") {
                sub = new Date(a.submittedAt).toLocaleTimeString(undefined, {
                  minute: "2-digit", second: "2-digit",
                });
              }
              const key = ["sort", "fastest", "order", "nominee", "match", "clues"].includes(round.answerFormat) ||
                (round.answerFormat === "choice" && Boolean(q.multi))
                ? t.id                      // never merge rows where timing or detail matters
                : normalise(a.value) || "(blank)";
              const existing = clusters.get(key);
              if (existing) { existing.teams.push(t.id); existing.names.push(t.name); }
              else clusters.set(key, { display, teams: [t.id], names: [t.name], points: a.points, sub });
            }
            const list = [...clusters.values()];
            if (round.answerFormat === "fastest") {
              // Earliest first, so the race is readable at a glance.
              list.sort((x, y) => {
                const ax = s.answers[answerKey(x.teams[0], q.id)]?.submittedAt ?? 0;
                const ay = s.answers[answerKey(y.teams[0], q.id)]?.submittedAt ?? 0;
                return ax - ay;
              });
            }
            const answerText = describeAnswer(round, q);
            const suggested = (v: string) =>
              normalise(v) === normalise(q.correct) || q.accepted.some((x) => normalise(x) === normalise(v));

            return (
              <div key={q.id}>
                {/* The answer key, stated plainly. Marking happens with a room
                    waiting, so it shouldn't be something you have to hunt for. */}
                <div className="mb-3 rounded-lg px-3 py-2.5"
                  style={{ background: C.row, borderLeft: `4px solid ${answerText ? C.correct : C.marker}` }}>
                  <div className="text-sm mb-1.5" style={{ color: C.inkDim }}>{q.prompt}</div>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs uppercase"
                      style={{ color: C.inkDim, letterSpacing: "0.14em", fontWeight: 700 }}>
                      Answer
                    </span>
                    <span style={{ color: answerText ? C.correct : C.marker, fontWeight: 700, fontSize: 17 }}>
                      {answerText || "none set in the editor — nothing to mark against"}
                    </span>
                  </div>
                  {q.accepted.length > 0 && (
                    <div className="text-xs mt-1.5" style={{ color: C.inkDim }}>
                      Also accept: <span style={{ color: C.ink }}>{q.accepted.join(", ")}</span>
                    </div>
                  )}
                  {round.answerFormat === "nominee" && (
                    <div className="text-xs mt-1.5" style={{ color: C.inkDim }}>
                      Each team is marked against their own nominee, shown on their row.
                    </div>
                  )}
                </div>
                {list.length === 0 && <p className="text-sm" style={{ color: C.inkDim }}>No answers submitted.</p>}
                <div className="flex flex-col gap-2">
                  {list.map((cl, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2"
                      style={{ background: C.card, border: `1px solid ${suggested(cl.display) ? C.correct : C.rule}` }}>
                      <div className="flex-1 min-w-32">
                        <div className="flex items-center gap-1.5" style={{ fontWeight: 600 }}>
                          {suggested(cl.display) && <Check size={14} strokeWidth={3} style={{ color: C.correct }} />}
                          {cl.display}
                        </div>
                        <div className="text-xs" style={{ color: C.inkDim }}>
                          {cl.names.join(", ")}{cl.sub ? ` · ${cl.sub}` : ""}
                          {round.answerFormat === "fastest" && i === 0 ? " · first in" : ""}
                          {round.wager ? ` · staked ${s.wagers?.[answerKey(cl.teams[0], q.id)] ?? 0}` : ""}
                        </div>
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

function Fatal({ title, detail, action, onAction }: {
  title: string; detail: string; action: string; onAction: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: C.page, color: C.ink }}>
      <div className="max-w-sm text-center">
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 26, letterSpacing: "-0.02em" }}>{title}</div>
        <p className="mt-2 mb-5 text-sm" style={{ color: C.inkDim }}>{detail}</p>
        <Btn tone="primary" onClick={onAction}>{action}</Btn>
      </div>
    </div>
  );
}
