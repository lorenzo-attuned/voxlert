import { existsSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../paths.js";

const MUTE_FILE = join(STATE_DIR, "muted");
const MUTE_QUEUE_DIR = join(STATE_DIR, "mute-queue");

export function isMuted() {
  return existsSync(MUTE_FILE);
}

export function queueWhileMuted(data) {
  mkdirSync(MUTE_QUEUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(MUTE_QUEUE_DIR, filename), JSON.stringify(data));
}

export function drainMuteQueue() {
  if (!existsSync(MUTE_QUEUE_DIR)) return [];
  const files = readdirSync(MUTE_QUEUE_DIR).filter(f => f.endsWith(".json")).sort();
  const items = [];
  for (const f of files) {
    const path = join(MUTE_QUEUE_DIR, f);
    try {
      items.push(JSON.parse(readFileSync(path, "utf-8")));
      unlinkSync(path);
    } catch {
      try { unlinkSync(path); } catch {}
    }
  }
  return items;
}

export const muteCommand = {
  name: "mute",
  aliases: [],
  help: [
    "  voxlert mute                 Mute audio — queues messages until unmute",
  ],
  skipSetupWizard: true,
  skipUpgradeCheck: true,
  async run() {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MUTE_FILE, new Date().toISOString());
    console.log("Muted. Messages will be queued. Run 'voxlert unmute' to resume.");
  },
};

export const unmuteCommand = {
  name: "unmute",
  aliases: [],
  help: [
    "  voxlert unmute               Unmute audio — plays queued messages",
  ],
  skipSetupWizard: true,
  skipUpgradeCheck: true,
  async run() {
    if (!existsSync(MUTE_FILE)) {
      console.log("Already unmuted.");
      return;
    }
    unlinkSync(MUTE_FILE);
    const queued = drainMuteQueue();
    console.log(`Unmuted. ${queued.length} queued message(s) will play on the listener.`);
  },
};
