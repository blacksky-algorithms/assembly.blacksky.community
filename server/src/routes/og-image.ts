import fs from "node:fs";
import path from "node:path";

import LruCache from "lru-cache";
import sharp from "sharp";

import { getConversationInfoByConversationId } from "../conversation";
import logger from "../utils/logger";

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;

// Cache generated images (max 200 entries)
const imageCache = new LruCache<string, Buffer>({
  max: 200,
});

// Load base image at startup.
// Assets are in src/assets/ relative to the project root (process.cwd()).
const assetsDir = path.join(process.cwd(), "src", "assets");
const baseImageBuffer = fs.readFileSync(
  path.join(assetsDir, "blacksky-logo.png")
);

const DEFAULT_IMAGE_URL =
  "https://blacksky-cdn.nyc3.cdn.digitaloceanspaces.com/peoples-assembly.png";

/**
 * Word-wrap text into lines that fit within a max character width.
 */
function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Escape special XML characters for safe SVG embedding.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build an SVG overlay containing the topic title in Rubik Bold.
 * The Rubik font is installed system-wide via the Dockerfile,
 * so librsvg (used by sharp) can resolve it by name.
 */
function buildTitleOverlay(topic: string): string {
  const lines = wrapText(topic, 32);
  const fontSize = lines.some((l) => l.length > 28) ? 42 : 48;
  const lineHeight = fontSize * 1.3;

  // The base image has the logo in the top third, "People's Assembly" in the middle.
  // Place the topic title in the lower portion, above a bottom margin.
  const totalTextHeight = lines.length * lineHeight;
  const startY = IMAGE_HEIGHT - 80 - totalTextHeight;

  const textElements = lines
    .map((line, i) => {
      const y = startY + i * lineHeight;
      return `<text x="${IMAGE_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="Rubik" font-weight="700" font-size="${fontSize}" fill="#1a1a1a">${escapeXml(line)}</text>`;
    })
    .join("\n    ");

  return `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="none"/>
  <rect x="80" y="${startY - fontSize - 10}" width="${IMAGE_WIDTH - 160}" height="2" fill="#d0d0d0" rx="1"/>
    ${textElements}
</svg>`;
}

export function handle_GET_ogImage(
  req: { params: { conversation_id: string } },
  res: {
    set: (headers: Record<string, string>) => void;
    status: (code: number) => { end: () => void };
    redirect: (url: string) => void;
    end: (data: Buffer) => void;
  }
) {
  const conversation_id = req.params.conversation_id;

  if (!conversation_id || !/^[0-9][0-9A-Za-z]+$/.test(conversation_id)) {
    res.redirect(DEFAULT_IMAGE_URL);
    return;
  }

  // Check cache first
  const cached = imageCache.get(conversation_id);
  if (cached) {
    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(cached);
    return;
  }

  getConversationInfoByConversationId(conversation_id)
    .then(async (conv) => {
      const topic = conv?.topic;
      if (!topic) {
        res.redirect(DEFAULT_IMAGE_URL);
        return;
      }

      const svgOverlay = buildTitleOverlay(topic);
      const svgBuffer = Buffer.from(svgOverlay);

      const pngBuffer = await sharp(baseImageBuffer)
        .composite([{ input: svgBuffer, top: 0, left: 0 }])
        .png()
        .toBuffer();

      imageCache.set(conversation_id, pngBuffer);

      res.set({
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(pngBuffer);
    })
    .catch((err) => {
      logger.error("polis_err_generating_og_image", err);
      res.redirect(DEFAULT_IMAGE_URL);
    });
}
