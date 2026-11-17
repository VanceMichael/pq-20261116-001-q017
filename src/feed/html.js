const ENTITY_MAP = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'],
  ["apos", "'"], ["nbsp", " "], ["mdash", "—"], ["hellip", "…"]
]);

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : "�";
    }
    return ENTITY_MAP.get(entity.toLowerCase()) ?? match;
  });
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const key = match[1].toLowerCase();
    if (!(key in attributes)) attributes[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function textContent(value) {
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\s]+/g, " ")).trim();
}

function looksLikeArticleUrl(value) {
  return /\.(?:s?html?)(?:[?#].*)?$/i.test(value) || /\/news\d{5,}(?:[/?#]|$)/i.test(value);
}

export function extractLinks(html, baseUrl) {
  if (typeof html !== "string" || html.length === 0) throw new TypeError("HTML must be a non-empty string");
  if (html.length > 5_000_000) throw new RangeError("HTML capture exceeds 5 MB");
  const tokens = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
  const found = [];
  let active = null;
  let lastTime = null;
  let token;
  while ((token = tokens.exec(html))) {
    const raw = token[0];
    if (raw.startsWith("<!--")) continue;
    if (raw[0] !== "<") {
      if (active) active.text += raw;
      continue;
    }
    const closing = /^<\s*\//.test(raw);
    const nameMatch = raw.match(/^<\s*\/?\s*([a-z][\w:-]*)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      if (name === "a" && active) {
        const title = textContent(active.text);
        const href = active.href.trim();
        if (title && href && looksLikeArticleUrl(href)) {
          found.push({ href, title, publishedAt: active.publishedAt ?? lastTime });
        }
        active = null;
      }
      continue;
    }
    const attributes = parseAttributes(raw.slice(nameMatch[0].length, raw.length - 1));
    if (name === "script" || name === "style") {
      const rawTextEnd = new RegExp(`<\\/\\s*${name}\\s*>`, "ig");
      rawTextEnd.lastIndex = tokens.lastIndex;
      const closingTag = rawTextEnd.exec(html);
      if (closingTag) tokens.lastIndex = rawTextEnd.lastIndex;
      continue;
    }
    if (name === "time") lastTime = attributes.datetime ?? lastTime;
    if (name === "a") {
      if (active) active = null;
      active = { href: attributes.href ?? "", text: "", publishedAt: lastTime };
    }
    if (name === "br" && active) active.text += " ";
  }
  if (active) {
    const title = textContent(active.text);
    if (title && active.href && looksLikeArticleUrl(active.href)) {
      found.push({ href: active.href.trim(), title, publishedAt: active.publishedAt ?? lastTime });
    }
  }
  return found.map((item) => {
    try {
      return { ...item, href: new URL(item.href, baseUrl).href };
    } catch {
      return item;
    }
  });
}

export const PARSER_VERSION = "feed-html/1.0.0";

export function pageFingerprint(html) {
  return createHashForContent(html);
}

function createHashForContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

import { createHash } from "node:crypto";
