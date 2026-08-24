import WebSocket from "ws";
import { readFileSync } from "node:fs";
const PORT="8899", API=`http://127.0.0.1:${PORT}`, KEY="test-password";
const post=async(p,b,a)=>(await fetch(API+p,{method:"POST",headers:{"Content-Type":"application/json",...(a?{Authorization:`Bearer ${a}`}:{})},body:JSON.stringify(b)})).json();
const open=(u)=>new Promise((r,j)=>{const w=new WebSocket(u);w.snaps=[];w.on("message",m=>{const p=JSON.parse(m);if(p.type==="snapshot")w.snaps.push(p.snapshot);});w.on("open",()=>r(w));w.on("error",j);});
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const S=w=>w.snaps[w.snaps.length-1];

const quiz = JSON.parse(readFileSync("demo-quiz.json","utf8"));
const s=await post("/api/sessions",{quiz},KEY);
const host=await open(`ws://127.0.0.1:${PORT}/ws?code=${s.joinCode}&role=host&key=${KEY}`);
await wait(300);
const hq = S(host).session.quiz;
console.log("what the HOST receives per format:\n");
for (const r of hq.rounds) {
  const q = r.questions[0];
  const bits = [];
  if (q.correct) bits.push(`correct="${q.correct.slice(0,24)}"`);
  if (q.listAnswers) bits.push(`listAnswers=${q.listAnswers.length}`);
  if (q.correctOptions) bits.push(`correctOptions=${JSON.stringify(q.correctOptions)}`);
  if (q.sequence) bits.push(`sequence=${q.sequence.length}`);
  if (q.pairs) bits.push(`pairs=${q.pairs.length}`);
  if (q.items) bits.push(`items=${q.items.filter(i=>i.category).length}/${q.items.length} categorised`);
  console.log(`  ${r.answerFormat.padEnd(8)} ${r.title.slice(0,26).padEnd(28)} ${bits.join("  ") || "*** NOTHING ***"}`);
}
process.exit(0);
