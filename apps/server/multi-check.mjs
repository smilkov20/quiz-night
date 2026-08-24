import WebSocket from "ws";
const PORT="8899", API=`http://127.0.0.1:${PORT}`, KEY="test-password";
const post=async(p,b,a)=>(await fetch(API+p,{method:"POST",headers:{"Content-Type":"application/json",...(a?{Authorization:`Bearer ${a}`}:{})},body:JSON.stringify(b)})).json();
const open=(u)=>new Promise((r,j)=>{const w=new WebSocket(u);w.snaps=[];w.on("message",m=>{const p=JSON.parse(m);if(p.type==="snapshot")w.snaps.push(p.snapshot);});w.on("open",()=>r(w));w.on("error",j);});
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const S=w=>w.snaps[w.snaps.length-1];
const quiz={id:"m",title:"M",updatedAt:0,tiebreakers:[],rounds:[{id:"r",order:0,title:"R",answerFormat:"choice",mediaType:"none",timeLimit:30,defaultMaxPoints:3,
 questions:[{id:"q",order:0,prompt:"Which are primes?",correct:"",accepted:[],maxPoints:3,mediaSource:"none",multi:true,
 options:["2","4","7","9"],correctOptions:["2","7"]}]}]};
const s=await post("/api/sessions",{quiz},KEY);
const t=await post("/api/join",{code:s.joinCode,name:"T"});
const ws=await open(`ws://127.0.0.1:${PORT}/ws?code=${s.joinCode}&role=team&teamId=${t.teamId}`);
await wait(250);
const q=S(ws).session.quiz.rounds[0].questions[0];
console.log("count the team sees:", (q.correctOptions ?? []).length, "(should be 2)");
console.log("values leaked:", JSON.stringify(q.correctOptions), "(should be blanks)");
process.exit(0);
