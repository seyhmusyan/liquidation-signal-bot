import fs from "fs";
import path from "path";

const adminPath = path.join(process.cwd(), "data", "admins.json");

export function isAdmin(id) {
  try {
    const raw = fs.readFileSync(adminPath, "utf8");
    const json = JSON.parse(raw);
    return json.admins.includes(id);
  } catch {
    return false;
  }
}
