import path from "path";
import dotenv from "dotenv";
import { ROOT_DIR } from "./paths.ts";

// Imported first by modules that read process.env at load time
dotenv.config({ path: [path.join(ROOT_DIR, ".env.local"), path.join(ROOT_DIR, ".env")], quiet: true });
