import { useEffect, useState } from "react";
import { C, FONT_DISPLAY } from "../ui/theme";
import { Countdown, Leaderboard } from "../ui/kit";
import { useQuizSocket } from "../useQuizSocket";
import { YouTubeStage, clipLen } from "../ui/YouTubeStage";

/** The projector. Read from fifteen metres across a noisy room, so type is
    enormous and there is only ever one thing on screen. */
export function PresenterSurface({ code, token }: { code: string; token: string }) {
  const { snapshot, fatal, send, now } = useQuizSocket({ code, role: "presenter", token });
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  if (fatal) {
    return (
      <Shell>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(26px,4.4vw,46px)" }}>
          {fatal === "no-room" ? "That room has ended" : "Link no longer valid"}
        </div>
        <p className="mt-3" style={{ color: C.inkDim }}>
          Open the room again on the host console for a fresh presenter link.
        </p>
      </Shell>
    );
  }
  if (!snapshot) return <Shell><p style={{ color: C.inkDim }}>Connecting…</p></Shell>;
  const s = snapshot.session;
  const round = s.quiz.rounds[s.roundIdx];
  const question = round?.questions[s.questionIdx];
  const remaining = s.questionStartedAt && round ? round.timeLimit - (now() - s.questionStartedAt) / 1000 : 0;
  const mediaLeft = s.mediaStartedAt && question ? clipLen(question) - (now() - s.mediaStartedAt) / 1000 : 0;
  const playing = s.phase === "playing_media";

  return (
    <>
      <YouTubeStage
        question={question ?? null}
        playing={playing}
        coverPicture={round?.mediaType === "audio"}
        onEnded={() => send({ type: "media_ended" })}
        size={playing ? "projector" : "hidden"}
      />
      <Shell>
        {s.state === "lobby" && (
          <>
            <div className="text-sm uppercase mb-4" style={{ color: C.biro, letterSpacing: "0.3em", fontWeight: 700 }}>
              Join the quiz
            </div>
            <div className="inline-block rounded-xl px-6 py-3" style={{ border: `3px solid ${C.biro}`, transform: "rotate(-1.4deg)" }}>
              <div style={{ fontFamily: "'DM Mono',monospace", fontSize: "clamp(44px,12vw,120px)", letterSpacing: "0.08em", color: C.biro, lineHeight: 1.1 }}>
                {s.joinCode}
              </div>
            </div>
            <p className="mt-8" style={{ color: C.inkDim }}>{s.teams.length} teams in</p>
          </>
        )}

        {s.state === "in_round" && question && round && (
          <>
            <div className="text-sm uppercase mb-6" style={{ color: C.biro, letterSpacing: "0.28em", fontWeight: 700 }}>
              Round {s.roundIdx + 1} · Question {s.questionIdx + 1}
            </div>
            {s.phase === "idle" ? (
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(32px,6vw,68px)", lineHeight: 1.15, letterSpacing: "-0.02em" }}>
                <span style={{ background: C.high, padding: "0.02em 0.18em" }}>{round.title}</span>
              </div>
            ) : (
              <p style={{ fontSize: playing ? "clamp(17px,2.2vw,26px)" : "clamp(26px,4.4vw,52px)", fontWeight: 600, lineHeight: 1.15 }}>
                {question.prompt}
              </p>
            )}
            {playing && (
              <p className="text-lg" style={{ color: C.inkDim, marginTop: "calc(48vh + 56px)" }}>
                {round.mediaType === "audio" ? "Listen" : "Watch"} · {Math.ceil(Math.max(0, mediaLeft))}s
              </p>
            )}
            {s.phase === "answering" && remaining > 0 && (
              <div className="mt-10 flex justify-center">
                <Countdown remaining={remaining} total={round.timeLimit} size="lg" />
              </div>
            )}
            {(s.phase === "locked" || (s.phase === "answering" && remaining <= 0)) && (
              <div className="mt-10" style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(30px,5.4vw,60px)", color: C.marker }}>
                Pens down
              </div>
            )}
          </>
        )}

        {s.state === "round_review" && s.reviewRound != null && (
          <>
            <div className="text-sm uppercase mb-2" style={{ color: C.biro, letterSpacing: "0.28em", fontWeight: 700 }}>
              Round {s.reviewRound + 1} answers
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(26px,4.4vw,46px)", marginBottom: 20 }}>
              {s.quiz.rounds[s.reviewRound].title}
            </div>
            <ol className="text-left flex flex-col gap-2">
              {s.quiz.rounds[s.reviewRound].questions.map((q, i) => (
                <li key={q.id} className="rounded-md px-3 py-2.5" style={{ background: C.row }}>
                  <div className="text-sm" style={{ color: C.inkDim }}>{i + 1}. {q.prompt}</div>
                  <div style={{ color: C.biro, fontWeight: 700, fontSize: 22 }}>{q.correct}</div>
                </li>
              ))}
            </ol>
          </>
        )}

        {(s.state === "leaderboard" || s.state === "finished") && (
          <>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(30px,5.4vw,60px)", letterSpacing: "-0.02em" }}>
              {s.state === "finished" ? "Final scores" : "Standings"}
            </div>
            {snapshot.ungradedCount > 0 && (
              <p className="mb-4 text-sm" style={{ color: C.marker }}>
                Provisional — {snapshot.ungradedCount} answers still to mark
              </p>
            )}
            <div className="mt-6 text-left max-w-xl mx-auto"><Leaderboard standings={snapshot.standings} /></div>
          </>
        )}

        {s.state === "tiebreaker" && (
          <>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: "clamp(30px,5.4vw,58px)", color: C.marker }}>Tiebreaker</div>
            <p className="mt-2 mb-8" style={{ color: C.biro, fontWeight: 600, fontSize: 20 }}>
              {s.tiebreakTeams.map((id) => s.teams.find((t) => t.id === id)?.name).filter(Boolean).join("  vs  ")}
            </p>
            <p style={{ fontSize: "clamp(24px,4vw,44px)", fontWeight: 600, lineHeight: 1.2 }}>
              {s.quiz.tiebreakers[s.tiebreakIdx]?.prompt}
            </p>
            {s.quiz.tiebreakers[s.tiebreakIdx]?.mode === "closest" && (
              <p className="mt-4" style={{ color: C.inkDim }}>Closest answer wins</p>
            )}
          </>
        )}
      </Shell>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 sm:p-12" style={{ background: C.page, color: C.ink }}>
      <div className="w-full max-w-4xl text-center">{children}</div>
    </div>
  );
}
