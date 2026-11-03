import "../../scripts/testing/sandbox.ts";
import { afterAll, afterEach } from "vitest";

// Windows will not remove a directory holding an open SQLite database: close it before the reset.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);
afterAll(closeMessageDb);
