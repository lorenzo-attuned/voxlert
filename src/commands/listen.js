import { createServer } from "http";
import { createHash } from "crypto";
import { loadConfig } from "../config.js";
import { speakPhrase } from "../audio.js";
import { loadPack } from "../packs.js";

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
      console.log(`  ${ts()} [${project}] ${label}: ${phrase}`);

      // Load pack (use pack_id from remote if available, otherwise config default)
      const listenConfig = { ...config };
      if (packId) listenConfig.active_pack = packId;
      const pack = loadPack(listenConfig);

      await speakPhrase(phrase, listenConfig, pack);

      // ntfy notification
      const ntfyTopic = config.ntfy_topic || "";
      if (ntfyTopic) {
        const { request } = await import("https");
        const ntfyTitle = `${project ? project + " — " : ""}${label}`;
        let ntfyBody = "";
        if (contextSnippet) {
          ntfyBody = contextSnippet.replace(/\s+/g, " ").slice(0, 200) + "\n\n";
        }
        ntfyBody += `🎙 ${phrase}`;

        const ntfyReq = request(
          `https://ntfy.sh/${ntfyTopic}`,
          {
            method: "POST",
            headers: {
              "Title": ntfyTitle,
              "Tags": category,
              "Content-Length": Buffer.byteLength(ntfyBody),
            },
          },
          (r) => { r.resume(); },
        );
        ntfyReq.on("error", () => {});
        ntfyReq.write(ntfyBody);
        ntfyReq.end();
      }
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

    // Keep running until Ctrl+C
    await new Promise(() => {});
  },
};
