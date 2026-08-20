import { DurableObject } from "cloudflare:workers";
import type { Quiz } from "@quiz/shared";
import type { Env } from "./index";

/* Singleton object holding the quiz bank. Quizzes are durable content;
   sessions are disposable, so they live in separate objects. */
export class QuizLibrary extends DurableObject<Env> {
  async list(): Promise<Quiz[]> {
    const map = await this.ctx.storage.list<Quiz>({ prefix: "quiz:" });
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Quiz | null> {
    return (await this.ctx.storage.get<Quiz>(`quiz:${id}`)) ?? null;
  }

  async save(quiz: Quiz): Promise<Quiz> {
    const next = { ...quiz, updatedAt: Date.now() };
    await this.ctx.storage.put(`quiz:${next.id}`, next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.storage.delete(`quiz:${id}`);
  }
}
