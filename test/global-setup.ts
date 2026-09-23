import { runMigrations } from "../src/db/migrate.js";
import { TEST_DATABASE_URL } from "./helpers.js";

export default async function setup() {
  await runMigrations(TEST_DATABASE_URL);
}
