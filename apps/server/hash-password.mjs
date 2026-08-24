#!/usr/bin/env node
/* Turns a password into a scrypt hash for HOST_PASSWORD, so the password
   itself never sits readable in a hosting dashboard.

   Usage:  pnpm hash-password            (prompts)
           pnpm hash-password "secret"   (argument) */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const { hashPassword } = await import("./src/auth.ts").catch(async () => {
  // Plain node can't read TypeScript; fall back to a local implementation.
  const { randomBytes, scryptSync } = await import("node:crypto");
  return {
    hashPassword: (plain) => {
      const salt = randomBytes(16);
      const key = scryptSync(plain.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
      return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
    },
  };
});

let password = process.argv[2];
if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question("Password: ");
  rl.close();
}
if (!password?.trim()) {
  console.error("No password given.");
  process.exit(1);
}
if (password.trim().length < 8) {
  console.warn("\nThat's under 8 characters. It's the only thing between a stranger and your quiz.\n");
}

console.log("\nSet this as HOST_PASSWORD in your service settings:\n");
console.log(hashPassword(password.trim()));
console.log("\nKeep the original password — you sign in with that, not the hash.\n");
