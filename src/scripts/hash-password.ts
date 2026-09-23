// Usage: npm run hash-password
// Prompts for the admin password and prints the value to put in ADMIN_PASSWORD_HASH in .env.
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../services/auth.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Admin password (min 12 characters): ");
rl.close();
if (password.length < 12) {
  console.error("Too short. Use at least 12 characters.");
  process.exit(1);
}
console.log(`\nADMIN_PASSWORD_HASH='${await hashPassword(password)}'`);
