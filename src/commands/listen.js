import { createServer } from "http";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config.js";
import { speakPhrase } from "../audio.js";
import { loadPack } from "../packs.js";
import { STATE_DIR } from "../paths.js";
import { isMuted, queueWhileMuted, drainMuteQueue } from "./mute.js";

// --- Dedup / rate-limit state ---
const seen = new Map(); // key → timestamp (ms)

function isDuplicate(key, windowMs) {
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last < windowMs) {
    return true;
  }
  seen.set(key, now);
  return false;
}

// Clean old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > 600_000) seen.delete(key);
  }
}, 300_000);

function categoryLabel(category) {
  const labels = {
    "task.complete": "Task complete",
    "task.error": "Error",
    "input.required": "Input needed",
    "session.start": "Session started",
    "session.end": "Session ended",
    "resource.limit": "Context limit",
    "notification": "Notification",
  };
  return labels[category] || category || "Unknown";
}

function ts() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function sendNtfy(config, project, label, category, contextSnippet, phrase) {
  const ntfyTopic = config.ntfy_topic || "";
  if (!ntfyTopic) return;
  import("https").then(({ request }) => {
    const ntfyTitle = `${project ? project + " - " : ""}${label}`;
    let ntfyBody = "";
    if (contextSnippet) {
      ntfyBody = contextSnippet.replace(/\s+/g, " ").slice(0, 200) + "\n\n";
    }
    ntfyBody += phrase;
    const encodedTitle = Buffer.from(ntfyTitle).toString("base64");
    const ntfyReq = request(
      `https://ntfy.sh/${ntfyTopic}`,
      {
        method: "POST",
        headers: {
          "X-Title": "=?UTF-8?B?" + encodedTitle + "?=",
          "X-Tags": category,
          "Content-Length": Buffer.byteLength(ntfyBody),
        },
      },
      (r) => { r.resume(); },
    );
    ntfyReq.on("error", () => {});
    ntfyReq.write(ntfyBody);
    ntfyReq.end();
  });
}

async function playQueue(items, config) {
  for (const item of items) {
    const listenConfig = { ...config, remote_playback_url: null };
    if (item.pack_id) listenConfig.active_pack = item.pack_id;
    const pack = loadPack(listenConfig);
    console.log(`  ${ts()} QUEUED: ${item.phrase}`);
    await speakPhrase(item.phrase, listenConfig, pack);
  }
}

// Serial queue — ensures only one TTS request runs at a time
const ttsQueue = [];
let ttsProcessing = false;

function enqueueTTS(fn) {
  ttsQueue.push(fn);
  drainTTSQueue();
}

async function drainTTSQueue() {
  if (ttsProcessing) return;
  ttsProcessing = true;
  while (ttsQueue.length > 0) {
    const fn = ttsQueue.shift();
    try {
      await fn();
    } catch (err) {
      console.log(`  ${ts()} TTS error: ${err.message}`);
    }
  }
  ttsProcessing = false;
}

export const listenCommand = {
  name: "listen",
  aliases: [],
  help: [
    "  voxlert listen [port]        Start remote playback listener (default: 7890)",
    "                               Receives phrases from remote voxlert, runs local TTS + playback",
  ],
  skipSetupWizard: true,
  skipUpgradeCheck: true,
  async run(context) {
    const port = parseInt(context.args[1], 10) || 7890;
    const config = loadConfig(process.cwd());
    const denyProjects = (config.listener_deny_projects || "").split(",").filter(Boolean);
    const dedupSecs = config.listener_dedup_secs ?? 300;
    const rateSecs = config.listener_rate_secs ?? 120;

    // Compile mic-check binary if not present
    const micCheckBin = join(STATE_DIR, "mic-check");
    const micCheckSrc = join(new URL(".", import.meta.url).pathname, "..", "..", "tools", "mic-check.swift");
    if (!existsSync(micCheckBin) && existsSync(micCheckSrc)) {
      try {
        execSync(`swiftc -O "${micCheckSrc}" -o "${micCheckBin}"`, { timeout: 30000 });
        console.log("  Compiled mic-check binary");
      } catch {
        console.log("  WARN: Could not compile mic-check — meeting detection disabled");
      }
    }

    // Mic detection state
    let micActive = false;
    if (existsSync(micCheckBin)) {
      setInterval(() => {
        try {
          const result = execSync(micCheckBin, { encoding: "utf-8", timeout: 2000 }).trim();
          const wasActive = micActive;
          micActive = result === "active";
          if (micActive && !wasActive) {
            console.log(`  ${ts()} MIC: microphone active — auto-muting`);
          } else if (!micActive && wasActive) {
            console.log(`  ${ts()} MIC: microphone inactive — resuming`);
            // Play queued messages
            const queued = drainMuteQueue();
            if (queued.length > 0) {
              console.log(`  ${ts()} MIC: playing ${queued.length} queued message(s)`);
              playQueue(queued, config);
            }
          }
        } catch {
          // ignore — mic check failed
        }
      }, 5000);
    }

    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return;
      }

      const phrase = data.phrase || "";
      const volume = data.volume ?? 0.5;
      const event = data.event || "";
      const category = data.category || "";
      const project = data.project || "";
      const packId = data.pack_id || "";
      const contextSnippet = data.context || "";

      if (!phrase) return;

      const label = categoryLabel(category);

      // --- Filtering ---

      // 1. Project deny list
      if (denyProjects.includes(project)) {
        console.log(`  ${ts()} [${project}] DENIED: ${phrase}`);
        return;
      }

      // 2. Phrase dedup
      const phraseKey = "phrase:" + createHash("md5").update(phrase).digest("hex");
      if (isDuplicate(phraseKey, dedupSecs * 1000)) {
        console.log(`  ${ts()} [${project}] DEDUP: ${phrase}`);
        return;
      }

      // 3. Rate limit per project+category
      if (project && category) {
        const rateKey = `rate:${project}:${category}`;
        if (isDuplicate(rateKey, rateSecs * 1000)) {
          console.log(`  ${ts()} [${project}] RATE: ${label} — ${phrase}`);
          return;
        }
      }

      // --- Passed filters ---

      // 4. Mute check (manual or mic-detected)
      if (isMuted() || micActive) {
        const reason = isMuted() ? "MUTED" : "MIC";
        console.log(`  ${ts()} [${project}] ${reason}: ${phrase}`);
        queueWhileMuted({ phrase, project, category, pack_id: packId, context: contextSnippet });
        // Still send ntfy even when muted
        sendNtfy(config, project, label, category, contextSnippet, phrase);
        return;
      }

      console.log(`  ${ts()} [${project}] ${label}: ${phrase}`);

      sendNtfy(config, project, label, category, contextSnippet, phrase);

      // Queue TTS so only one runs at a time (prevents timeouts from concurrent requests)
      enqueueTTS(async () => {
        const listenConfig = { ...config, remote_playback_url: null };
        if (packId) listenConfig.active_pack = packId;
        const pack = loadPack(listenConfig);
        await speakPhrase(phrase, listenConfig, pack);
      });
    });

    server.listen(port, () => {
      console.log(`voxlert listen: listening on port ${port}`);
      console.log(`  TTS backend: ${config.tts_backend || "qwen"}`);
      if (config.ntfy_topic) console.log(`  ntfy topic: ${config.ntfy_topic}`);
      if (denyProjects.length) console.log(`  denied projects: ${denyProjects.join(", ")}`);
      console.log(`  dedup window: ${dedupSecs}s | rate limit: ${rateSecs}s`);
      console.log(`  Configure remote voxlert with:`);
      console.log(`    remote_playback_url: http://<this-machine>:${port}/play`);
      console.log("");
    });

    // Reap stale voxlert hook processes every 30 seconds
    setInterval(() => {
      try {
        // macOS ps doesn't support etimes; use etime (elapsed time as [[dd-]hh:]mm:ss)
        const output = execSync(
          "ps -eo pid,etime,command | grep '[v]oxlert hook'",
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        if (!output) return;
        const stale = [];
        for (const line of output.split("\n")) {
          const match = line.trim().match(/^(\d+)\s+([\d:.-]+)/);
          if (!match) continue;
          const pid = match[1];
          const etime = match[2]; // format: ss, mm:ss, hh:mm:ss, or dd-hh:mm:ss
          // Parse elapsed time to seconds
          const parts = etime.replace(/-/g, ":").split(":").map(Number);
          let secs = 0;
          if (parts.length === 1) secs = parts[0];
          else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
          else if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else secs = parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
          if (secs > 30) stale.push(pid);
        }
        if (stale.length > 0) {
          execSync(`kill ${stale.join(" ")} 2>/dev/null`, { timeout: 2000 });
          console.log(`  ${ts()} REAPER: killed ${stale.length} stale hook process(es)`);
        }
      } catch {
        // ignore
      }
    }, 30000);

    // Keep running until Ctrl+C
    await new Promise(() => {});
  },
};
