// BRB card customization — the owner edits the card text and/or uploads a
// fullscreen image or looping video from the app. The relay supervisor fetches
// the current card every time it swaps to BRB (see server/relay/brb/), so
// changes apply on the next drop with no relay redeploy:
//   GET  /brb/config  (public)  { text, kind, mime, updatedAt }
//   GET  /brb/text    (public)  text/plain — drawtext-safe (served verbatim)
//   GET  /brb/media   (public)  the uploaded bytes, If-Modified-Since aware
//   PUT  /brb/config  (owner)   { text }
//   POST /brb/media   (owner)   raw image/* or video/* body, streamed to disk
//   DELETE /brb/media (owner)
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

const MAX_MEDIA_BYTES = 100_000_000; // 100 MB — plenty for a looping card
const MAX_TEXT_CHARS = 120;

export interface BrbMeta {
  text: string;
  kind: "none" | "image" | "video";
  mime: string;
  updatedAt: string;
}

export class Brb {
  private store: Store;
  private mediaPath: string;

  constructor(store: Store, dataDir: string) {
    this.store = store;
    mkdirSync(dataDir, { recursive: true });
    this.mediaPath = `${dataDir}/brb-media.bin`;
  }

  meta(): BrbMeta {
    const raw = this.store.getKv("brb");
    const m = raw ? (JSON.parse(raw) as Partial<BrbMeta>) : {};
    const kind = m.kind === "image" || m.kind === "video" ? m.kind : "none";
    return {
      text: typeof m.text === "string" ? m.text : "",
      // Heal a stale row if the file vanished (volume wipe, manual delete).
      kind: kind !== "none" && !existsSync(this.mediaPath) ? "none" : kind,
      mime: typeof m.mime === "string" ? m.mime : "",
      updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
    };
  }

  private save(meta: BrbMeta): void {
    this.store.setKv("brb", JSON.stringify(meta));
  }

  setText(text: string): BrbMeta {
    const meta = this.meta();
    // One line — the card renders a single centered row.
    meta.text = text.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
    meta.updatedAt = new Date().toISOString();
    this.save(meta);
    return meta;
  }

  /** Stream an upload to disk (never buffered in memory). Resolves to the new
      meta, or null when the content-type isn't an image/video. Rejects on
      oversize/stream errors. */
  upload(req: IncomingMessage): Promise<BrbMeta | null> {
    const mime = String(req.headers["content-type"] ?? "");
    const kind = mime.startsWith("image/")
      ? ("image" as const)
      : mime.startsWith("video/")
        ? ("video" as const)
        : null;
    if (!kind) return Promise.resolve(null);

    const tmp = `${this.mediaPath}.up`;
    return new Promise<BrbMeta | null>((resolve, reject) => {
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
        if (bytes > MAX_MEDIA_BYTES) fail(new Error("too large"));
      });
      req.on("error", fail);
      out.on("error", fail);
      req.pipe(out);
      out.on("finish", () => {
        if (bytes === 0) return fail(new Error("empty upload"));
        renameSync(tmp, this.mediaPath);
        const meta = this.meta();
        meta.kind = kind;
        meta.mime = mime;
        meta.updatedAt = new Date().toISOString();
        this.save(meta);
        resolve(meta);
      });
    });
  }

  removeMedia(): BrbMeta {
    try {
      unlinkSync(this.mediaPath);
    } catch {}
    const meta = this.meta();
    meta.kind = "none";
    meta.mime = "";
    meta.updatedAt = new Date().toISOString();
    this.save(meta);
    return meta;
  }

  /** GET /brb/media — public, cache-friendly (the supervisor polls with
      If-Modified-Since so an unchanged card is a 304, not a re-download). */
  serveMedia(req: IncomingMessage, res: ServerResponse): void {
    const meta = this.meta();
    if (meta.kind === "none" || !existsSync(this.mediaPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = statSync(this.mediaPath);
    const lastModified = stat.mtime.toUTCString();
    const since = req.headers["if-modified-since"];
    if (since && Date.parse(String(since)) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": meta.mime || "application/octet-stream",
      "content-length": stat.size,
      "last-modified": lastModified,
      "cache-control": "no-cache",
    });
    createReadStream(this.mediaPath).pipe(res);
  }
}
