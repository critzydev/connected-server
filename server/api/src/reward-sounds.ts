// Per-reward sound effects — the owner uploads a short audio file for a
// channel-point reward (discord ping, airhorn…); when that reward is redeemed
// the streaming phone fetches the file and mixes it INTO the broadcast (the
// same digital path as the TTS voice — viewers hear it, mic state irrelevant).
//   GET    /rewards                  (owner)  Helix rewards ∪ sound map
//   POST   /rewards/sound/<id>       (owner)  raw audio/* body → disk
//   DELETE /rewards/sound/<id>       (owner)
//   GET    /rewards/sound/<id>       (public) the bytes, If-Modified-Since aware
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.ts";

const MAX_SOUND_BYTES = 5_000_000; // 5 MB ≈ minutes of MP3 — plenty for a ping

export interface SoundMeta {
  mime: string;
  /** Reward title at upload time — lets the list render sounds for rewards
      Helix can't show (unlinked, or the reward was deleted on Twitch). */
  title: string;
  updatedAt: string;
}

export class RewardSounds {
  private store: Store;
  private dir: string;

  constructor(store: Store, dataDir: string) {
    this.store = store;
    this.dir = `${dataDir}/reward-sounds`;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Twitch reward ids are UUIDs; anything else is refused outright. */
  static safeId(id: string): string | null {
    return /^[a-zA-Z0-9-]{1,64}$/.test(id) ? id : null;
  }

  private path(id: string): string {
    return `${this.dir}/${id}.bin`;
  }

  all(): Record<string, SoundMeta> {
    const raw = this.store.getKv("rewardSounds");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, SoundMeta>;
    } catch {
      return {};
    }
  }

  meta(id: string): SoundMeta | null {
    const m = this.all()[id];
    if (!m || !existsSync(this.path(id))) return null;
    return m;
  }

  /** The hub-relative URL the speaker fetches (cache-busted by upload time). */
  soundUrl(id: string): string | null {
    const m = this.meta(id);
    if (!m) return null;
    return `/rewards/sound/${id}?v=${encodeURIComponent(m.updatedAt)}`;
  }

  private save(map: Record<string, SoundMeta>): void {
    this.store.setKv("rewardSounds", JSON.stringify(map));
  }

  upload(id: string, title: string, req: IncomingMessage): Promise<SoundMeta | null> {
    const mime = String(req.headers["content-type"] ?? "");
    if (!mime.startsWith("audio/")) return Promise.resolve(null);
    const tmp = `${this.path(id)}.up`;
    return new Promise<SoundMeta | null>((resolve, reject) => {
      const out = createWriteStream(tmp);
      let bytes = 0;
      const fail = (err: Error) => {
        out.destroy();
        req.destroy();
        try {
          unlinkSync(tmp);
        } catch {}
        reject(err);
      };
      req.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_SOUND_BYTES) fail(new Error("too large (5 MB max)"));
      });
      req.on("error", fail);
      out.on("error", fail);
      req.pipe(out);
      out.on("finish", () => {
        if (bytes === 0) return fail(new Error("empty upload"));
        renameSync(tmp, this.path(id));
        const meta: SoundMeta = {
          mime,
          title: title.slice(0, 100),
          updatedAt: new Date().toISOString(),
        };
        const map = this.all();
        map[id] = meta;
        this.save(map);
        resolve(meta);
      });
    });
  }

  remove(id: string): void {
    try {
      unlinkSync(this.path(id));
    } catch {}
    const map = this.all();
    delete map[id];
    this.save(map);
  }

  serve(id: string, req: IncomingMessage, res: ServerResponse): void {
    const m = this.meta(id);
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = statSync(this.path(id));
    const since = req.headers["if-modified-since"];
    if (since && Date.parse(String(since)) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": m.mime || "application/octet-stream",
      "content-length": stat.size,
      "last-modified": stat.mtime.toUTCString(),
      // Cache-busted by ?v=updatedAt — let clients keep it.
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(this.path(id)).pipe(res);
  }
}
