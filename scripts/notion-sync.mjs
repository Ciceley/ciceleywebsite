#!/usr/bin/env node
/**
 * Notion -> Hugo sync.
 *
 * Reads published pages from a Notion database, converts them to Hugo page
 * bundles under content/posts/, downloads the cover + inline images, and
 * removes posts that were previously synced but are no longer in Notion.
 *
 * Content-only: it does NOT touch git. Use `npm run sync:pr` to open a PR.
 *
 * Required env (see .env.example):
 *   NOTION_API_KEY       (falls back to `notionapikey` for backwards compat)
 *   NOTION_DATABASE_ID
 *
 * Optional env:
 *   NOTION_STATUS_PROP   property used to decide what is published
 *                        (checkbox "Published" or select/status "Status")
 *   NOTION_TITLE_PROP    title property name (default: "Name")
 *   NOTION_SLUG_PROP     rich_text slug property (default: "Slug")
 *   NOTION_DATE_PROP     date property (default: "Date")
 *   NOTION_DESC_PROP     rich_text description property (default: "Description")
 *   NOTION_TAGS_PROP     multi_select property (default: "Tags")
 *   NOTION_CATS_PROP     multi_select property (default: "Categories")
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import "dotenv/config";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POSTS_DIR = path.join(ROOT, "content", "posts");

const API_KEY = process.env.NOTION_API_KEY || process.env.notionapikey;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const P = {
  title: process.env.NOTION_TITLE_PROP || "Name",
  slug: process.env.NOTION_SLUG_PROP || "Slug",
  date: process.env.NOTION_DATE_PROP || "Date",
  desc: process.env.NOTION_DESC_PROP || "Description",
  tags: process.env.NOTION_TAGS_PROP || "Tags",
  cats: process.env.NOTION_CATS_PROP || "Categories",
  status: process.env.NOTION_STATUS_PROP || "Status",
};

function fail(msg) {
  console.error(`\n  Error: ${msg}\n`);
  process.exit(1);
}

if (!API_KEY) {
  fail(
    "Missing NOTION_API_KEY (or notionapikey). Copy .env.example to .env and add your token.",
  );
}
if (!DATABASE_ID) {
  fail(
    "Missing NOTION_DATABASE_ID. It is the 32-char id in your database URL:\n" +
      "  https://www.notion.so/<workspace>/<DATABASE_ID>?v=...",
  );
}

const notion = new Client({ auth: API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const slugify = (s) =>
  s
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const yamlStr = (v) => JSON.stringify(String(v ?? ""));

function prop(page, name) {
  const p = page.properties?.[name];
  return p || null;
}

function titleOf(page) {
  const p = prop(page, P.title);
  if (p?.type === "title") return p.title.map((t) => t.plain_text).join("").trim();
  // fall back to any title property
  const anyTitle = Object.values(page.properties || {}).find(
    (x) => x.type === "title",
  );
  return anyTitle?.title.map((t) => t.plain_text).join("").trim() || "";
}

function richText(page, name) {
  const p = prop(page, name);
  if (!p) return "";
  if (p.type === "rich_text") return p.rich_text.map((t) => t.plain_text).join("").trim();
  return "";
}

function dateOf(page) {
  const p = prop(page, P.date);
  if (p?.type === "date" && p.date?.start) return p.date.start.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function multiSelect(page, name) {
  const p = prop(page, name);
  if (p?.type === "multi_select") return p.multi_select.map((x) => x.name);
  return [];
}

function isPublished(page) {
  // Prefer an explicit status property; otherwise publish everything.
  for (const key of [P.status, "Published", "Status"]) {
    const p = prop(page, key);
    if (!p) continue;
    if (p.type === "checkbox") return p.checkbox;
    if (p.type === "select") return p.select?.name?.toLowerCase() === "published";
    if (p.type === "status")
      return ["published", "done", "complete"].includes(
        p.status?.name?.toLowerCase(),
      );
  }
  return true;
}

function extFromUrl(url, fallback = "png") {
  try {
    const clean = url.split("?")[0];
    const ext = path.extname(clean).replace(".", "").toLowerCase();
    return /^(png|jpe?g|gif|webp|svg|avif)$/.test(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf;
}

/* ------------------------------------------------------------------ */
/* assemble one post                                                   */
/* ------------------------------------------------------------------ */

async function buildPost(page) {
  const title = titleOf(page) || "Untitled";
  const slug = richText(page, P.slug) || slugify(title);
  const dir = path.join(POSTS_DIR, slug);
  await fs.mkdir(dir, { recursive: true });

  // Inline images -> local page-bundle files
  let imgCount = 0;
  const imageMap = new Map();
  n2m.setCustomTransformer("image", async (block) => {
    const img = block.image;
    const url = img?.type === "external" ? img.external?.url : img.file?.url;
    if (!url) return "";
    let name = imageMap.get(url);
    if (!name) {
      const ext = extFromUrl(url);
      name = `image-${++imgCount}.${ext}`;
      imageMap.set(url, name);
      try {
        await download(url, path.join(dir, name));
      } catch (e) {
        console.warn(`  ! ${slug}: could not download inline image (${e.message})`);
        return "";
      }
    }
    const alt = (img.caption || []).map((c) => c.plain_text).join("") || "";
    return `![${alt}](${name})`;
  });

  const mdBlocks = await n2m.pageToMarkdown(page.id);
  const body = n2m.toMarkdownString(mdBlocks).parent?.trimEnd() || "";

  // Cover image -> cover.<ext>
  let cover = "";
  const coverUrl =
    page.cover?.type === "external"
      ? page.cover.external?.url
      : page.cover?.file?.url;
  if (coverUrl) {
    try {
      const ext = extFromUrl(coverUrl, "jpg");
      cover = `cover.${ext}`;
      await download(coverUrl, path.join(dir, cover));
    } catch (e) {
      console.warn(`  ! ${slug}: could not download cover (${e.message})`);
      cover = "";
    }
  }

  const tags = multiSelect(page, P.tags);
  const cats = multiSelect(page, P.cats);
  const description = richText(page, P.desc);

  const fm = [
    "---",
    `title: ${yamlStr(title)}`,
    `date: ${dateOf(page)}`,
    `description: ${yamlStr(description)}`,
    `notionId: ${yamlStr(page.id)}`,
    `categories: ${JSON.stringify(cats)}`,
    `tags: ${JSON.stringify(tags)}`,
  ];
  if (cover) fm.push(`image: ${yamlStr(cover)}`);
  fm.push("---", "");

  await fs.writeFile(path.join(dir, "index.md"), fm.join("\n") + body + "\n", "utf8");
  return { slug, title };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function queryAll() {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function readManagedSlugs() {
  const managed = new Set();
  let entries = [];
  try {
    entries = await fs.readdir(POSTS_DIR, { withFileTypes: true });
  } catch {
    return managed;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const md = await fs.readFile(
        path.join(POSTS_DIR, e.name, "index.md"),
        "utf8",
      );
      if (/^notionId:/m.test(md)) managed.add(e.name);
    } catch {
      /* not a notion-managed bundle */
    }
  }
  return managed;
}

async function main() {
  await fs.mkdir(POSTS_DIR, { recursive: true });

  console.log("→ Reading from Notion…");
  const all = await queryAll();
  const published = all.filter(isPublished);
  console.log(
    `  ${all.length} page(s) in database, ${published.length} published.`,
  );

  const written = new Set();
  for (const page of published) {
    try {
      const { slug, title } = await buildPost(page);
      written.add(slug);
      console.log(`  ✓ ${slug}  (${title})`);
    } catch (e) {
      console.error(`  ✗ failed to sync page ${page.id}: ${e.message}`);
    }
  }

  // Remove previously-synced posts that are gone/unpublished in Notion.
  const managed = await readManagedSlugs();
  for (const slug of managed) {
    if (!written.has(slug)) {
      console.log(`  – removing ${slug} (no longer published)`);
      await fs.rm(path.join(POSTS_DIR, slug), { recursive: true, force: true });
    }
  }

  // Cheap change seed so `git status` is stable when nothing differs.
  void crypto;
  console.log(`\n✓ Synced ${written.size} post(s) into content/posts/`);
}

main().catch((e) => fail(e.stack || e.message));
