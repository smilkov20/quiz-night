import type { Quiz } from "@quiz/shared";

/* A quiz to start from, so a fresh deploy isn't an empty screen.
   Media questions have no links — paste your own in the editor. */
export const seedQuiz: Quiz = {
  id: "seed",
  title: "Thursday Night Quiz",
  updatedAt: 0,
  rounds: [
    {
      id: "r1", order: 0, title: "True or False",
      answerFormat: "yes_no", mediaType: "none", timeLimit: 20, defaultMaxPoints: 1,
      questions: [
        { id: "q1", order: 0, prompt: "A shrimp's heart is in its head.", correct: "Yes", accepted: [], maxPoints: null, mediaSource: "none" },
        { id: "q2", order: 1, prompt: "The Great Wall of China is visible from space with the naked eye.", correct: "No", accepted: [], maxPoints: null, mediaSource: "none" },
        { id: "q3", order: 2, prompt: "Iceland has no native mosquitoes.", correct: "Yes", accepted: [], maxPoints: null, mediaSource: "none" },
      ],
    },
    {
      id: "r2", order: 1, title: "General Knowledge",
      answerFormat: "text", mediaType: "none", timeLimit: 30, defaultMaxPoints: 1,
      questions: [
        { id: "q4", order: 0, prompt: "Which element has the chemical symbol W?", correct: "Tungsten", accepted: ["wolfram"], maxPoints: null, mediaSource: "none" },
        { id: "q5", order: 1, prompt: "What is the capital of Australia?", correct: "Canberra", accepted: [], maxPoints: null, mediaSource: "none" },
        { id: "q6", order: 2, prompt: "Who wrote The Master and Margarita?", correct: "Mikhail Bulgakov", accepted: ["bulgakov"], maxPoints: null, mediaSource: "none" },
      ],
    },
    {
      id: "r3", order: 2, title: "Music Round",
      answerFormat: "text", mediaType: "audio", timeLimit: 30, defaultMaxPoints: 2,
      questions: [
        { id: "q7", order: 0, prompt: "Name the artist and the track.", correct: "", accepted: [], maxPoints: null, mediaSource: "youtube", url: "", clipStart: 0, clipEnd: 15 },
        { id: "q8", order: 1, prompt: "Name the artist and the track.", correct: "", accepted: [], maxPoints: null, mediaSource: "youtube", url: "", clipStart: 0, clipEnd: 15 },
      ],
    },
    {
      id: "r4", order: 3, title: "Video Round",
      answerFormat: "text", mediaType: "video", timeLimit: 30, defaultMaxPoints: 1,
      questions: [
        { id: "q9", order: 0, prompt: "Name the film.", correct: "", accepted: [], maxPoints: null, mediaSource: "youtube", url: "", clipStart: 0, clipEnd: 12 },
        { id: "q10", order: 1, prompt: "Name the film.", correct: "", accepted: [], maxPoints: null, mediaSource: "youtube", url: "", clipStart: 0, clipEnd: 12 },
      ],
    },
    {
      id: "r5", order: 4, title: "The Hard Round",
      answerFormat: "text", mediaType: "none", timeLimit: 45, defaultMaxPoints: 3,
      questions: [
        { id: "q11", order: 0, prompt: "Name the world's only two doubly landlocked countries.", correct: "Liechtenstein and Uzbekistan", accepted: [], maxPoints: null, mediaSource: "none" },
        { id: "q12", order: 1, prompt: "Which country was the first to grant women the vote nationally?", correct: "New Zealand", accepted: [], maxPoints: null, mediaSource: "none" },
      ],
    },
    {
      id: "r6", order: 5, title: "Nail, Hair or Wall?",
      answerFormat: "sort", mediaType: "none", timeLimit: 90, defaultMaxPoints: 3,
      questions: [
        {
          id: "q13", order: 0,
          prompt: "Each of these is a real shade name. Which is a nail polish, which a hair colour, and which a paint?",
          correct: "", accepted: [], maxPoints: 3, mediaSource: "none",
          categories: ["Nail polish", "Hair colour", "Paint colour"],
          items: [
            { word: "Ballet Slippers", category: "Nail polish" },
            { word: "Ash Blonde", category: "Hair colour" },
            { word: "Elephant's Breath", category: "Paint colour" },
          ],
        },
      ],
    },
    {
      id: "r7", order: 6, title: "In Order",
      answerFormat: "order", mediaType: "none", timeLimit: 60, defaultMaxPoints: 4,
      questions: [
        {
          id: "q14", order: 0,
          prompt: "Put these planets in order of distance from the Sun, closest first.",
          correct: "", accepted: [], maxPoints: 4, mediaSource: "none",
          sequence: ["Mercury", "Venus", "Earth", "Mars"],
        },
      ],
    },
    {
      id: "r8", order: 7, title: "Buzzer Round",
      answerFormat: "fastest", mediaType: "none", timeLimit: 30,
      defaultMaxPoints: 1, fastestPoints: 2,
      questions: [
        {
          id: "q15", order: 0,
          prompt: "How many keys does a standard piano have?",
          correct: "88", accepted: [], maxPoints: null,
          fastestMode: "closest", mediaSource: "none",
        },
      ],
    },
  ],
  tiebreakers: [
    { id: "t1", order: 0, mode: "exact", prompt: "Which US state can be typed using only the home row of a QWERTY keyboard?", correct: "Alaska", timeLimit: 30 },
    { id: "t2", order: 1, mode: "closest", prompt: "How many steps lead to the top of the Eiffel Tower?", correct: "1665", timeLimit: 30 },
  ],
};
