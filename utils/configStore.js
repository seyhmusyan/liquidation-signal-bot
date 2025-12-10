import fs from "fs";
import path from "path";

const configPath = path.join(process.cwd(), "data", "config.json");

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { mode: "SWING" };
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
}
