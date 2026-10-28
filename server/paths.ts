import path from "path";
import { fileURLToPath } from "url";

// Project root (one level above /server)
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
