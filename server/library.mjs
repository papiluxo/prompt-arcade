/* The games library — the marketplace's storage layer.
 *
 * One JSON file per game under DATA_DIR/games. Small volume, human-readable,
 * greppable, and trivially portable. Everything is open source by design: the
 * full HTML source ships with every record.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const GAMES_DIR = join(DATA_DIR, 'games')

/** @type {Map<string, object>} id -> full record */
const cache = new Map()
let loaded = false

async function ensureDir() {
  await mkdir(GAMES_DIR, { recursive: true })
}

async function loadAll() {
  if (loaded) return
  await ensureDir()
  const files = (await readdir(GAMES_DIR)).filter((f) => f.endsWith('.json'))
  for (const file of files) {
    try {
      const rec = JSON.parse(await readFile(join(GAMES_DIR, file), 'utf8'))
      if (rec?.id) cache.set(rec.id, rec)
    } catch {
      /* skip corrupt record */
    }
  }
  loaded = true
}

async function persist(rec) {
  await ensureDir()
  await writeFile(join(GAMES_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2))
}

/** Metadata only — never ship every game's source in a list response. */
function summarize(rec) {
  const { html, ...meta } = rec
  return { ...meta, bytes: html?.length || 0 }
}

export async function listGames({ sort = 'recent', q = '' } = {}) {
  await loadAll()
  let games = [...cache.values()].map(summarize)
  if (q) {
    const needle = q.toLowerCase()
    games = games.filter((g) =>
      [g.title, g.tagline, g.brief, ...(g.tags || []), ...(g.authors || [])]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }
  const by = {
    recent: (a, b) => b.createdAt - a.createdAt,
    plays: (a, b) => b.plays - a.plays || b.createdAt - a.createdAt,
    remixes: (a, b) => b.remixes - a.remixes || b.createdAt - a.createdAt,
  }
  return games.sort(by[sort] || by.recent)
}

export async function getGame(id) {
  await loadAll()
  return cache.get(id) || null
}

export async function saveGame({
  title,
  tagline = '',
  brief = '',
  html,
  modelId,
  mode = 'multi',
  authors = [],
  tags = [],
  parentId = null,
}) {
  await loadAll()
  const now = Date.now()
  const rec = {
    id: randomUUID().slice(0, 8),
    title: (title || 'Untitled Game').slice(0, 80),
    tagline: tagline.slice(0, 160),
    brief,
    html,
    modelId,
    mode,
    authors,
    tags: tags.slice(0, 8),
    parentId,
    createdAt: now,
    updatedAt: now,
    plays: 0,
    remixes: 0,
  }
  if (parentId) {
    const parent = cache.get(parentId)
    if (parent) {
      parent.remixes = (parent.remixes || 0) + 1
      parent.updatedAt = now
      await persist(parent)
    }
  }
  cache.set(rec.id, rec)
  await persist(rec)
  return summarize(rec)
}

export async function recordPlay(id) {
  await loadAll()
  const rec = cache.get(id)
  if (!rec) return null
  rec.plays = (rec.plays || 0) + 1
  await persist(rec)
  return summarize(rec)
}

/** Lineage chain, oldest ancestor first. */
export async function lineage(id) {
  await loadAll()
  const chain = []
  let cur = cache.get(id)
  const seen = new Set()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift({ id: cur.id, title: cur.title, createdAt: cur.createdAt })
    cur = cur.parentId ? cache.get(cur.parentId) : null
  }
  return chain
}

/**
 * Bundle a game for download: same source, plus a solo MP shim so the file
 * plays offline by double-clicking it.
 */
export function bundleStandalone(rec, shimSource, libSources = []) {
  const banner = `<!--\n  ${rec.title} — built in Prompt Arcade with ${rec.modelId}\n  ${
    rec.authors?.length ? `by ${rec.authors.join(', ')}\n  ` : ''
  }Brief: ${(rec.brief || '').replace(/-->/g, '--&gt;').slice(0, 600)}\n\n  This file is standalone and open source: edit it, fork it, host it anywhere.\n-->\n`
  const libs = libSources
    .filter(Boolean)
    .map((src) => `<script>\n${src}\n</script>\n`)
    .join('')
  const shim = `<script>\n/* Prompt Arcade solo shim — replaces the multiplayer runtime. */\n${shimSource}\n</script>\n`
  return banner + injectBeforeGame(rec.html, libs + shim)
}

/** Put a script tag ahead of the game's own code. */
export function injectBeforeGame(html, snippet) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + snippet)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '\n' + snippet)
  return snippet + html
}
