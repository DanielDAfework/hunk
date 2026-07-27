import fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveGlobalExtensionsDir } from "../core/paths";
import { findVcsRepoRootCandidate } from "../core/vcs";
import { deriveExtensionId, type ExtensionCandidate, type ExtensionOrigin } from "./types";

/** Entry-file suffixes Hunk will import directly, in preference order. */
const EXTENSION_ENTRY_SUFFIXES = [".ts", ".js", ".mjs"] as const;
const EXTENSION_INDEX_BASENAMES = EXTENSION_ENTRY_SUFFIXES.map((suffix) => `index${suffix}`);

export interface DiscoverExtensionsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Repo root used for repo-local discovery; discovered from `cwd` when omitted. */
  repoRoot?: string;
  /** Paths from repeated `--extension` flags. */
  flagPaths?: readonly string[];
  /** Paths from the user config layer's `[extensions] paths`. */
  configPaths?: readonly string[];
  /** Paths from the repo config layer's `[extensions] paths`; trust-gated like `.hunk/extensions`. */
  repoConfigPaths?: readonly string[];
  /** Override the scanned global directory; discovery falls back to the XDG location. */
  globalExtensionsDir?: string;
}

/** Return whether one path exists and is a directory. */
function isDirectory(path: string) {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Return the directory's entries sorted by name, or nothing when it is unreadable. */
function readSortedDirEntries(dir: string) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Return the index entry directly inside one folder extension, if it has one.
 *
 * Preference order follows `EXTENSION_INDEX_BASENAMES`, so a folder shipping
 * both a source and a built entry resolves to the same one everywhere.
 */
function findFolderExtensionIndex(dir: string) {
  const indexBasename = EXTENSION_INDEX_BASENAMES.find((basename) =>
    fs.existsSync(join(dir, basename)),
  );
  return indexBasename ? join(dir, indexBasename) : undefined;
}

/**
 * Scan one extensions directory for entry files.
 *
 * Matches `<dir>/*.{ts,js,mjs}` plus exactly one level of
 * `<dir>/<name>/index.{ts,js,mjs}`, so folder extensions can keep helper
 * modules beside their entry file without being scanned as entries themselves.
 */
function scanExtensionsDir(dir: string) {
  const entryPaths: string[] = [];

  for (const entry of readSortedDirEntries(dir)) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const folderIndex = findFolderExtensionIndex(entryPath);
      if (folderIndex) {
        entryPaths.push(folderIndex);
      }
      continue;
    }

    if (EXTENSION_ENTRY_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      entryPaths.push(entryPath);
    }
  }

  return entryPaths;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Config files are hand-written and documented with `~/dev/...` paths, but TOML
 * has no shell to expand them, so `~` arrives literally. Only a bare `~` or a
 * `~/` prefix is expanded — `~user` is deliberately left alone, since resolving
 * another account's home is a shell feature Hunk has no business guessing at.
 * Both separators are accepted so a Windows config may write `~\dev\...`.
 */
function expandHomePath(path: string) {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

/**
 * Expand one explicit path into entry files.
 *
 * A directory holding its own `index.{ts,js,mjs}` is one folder extension and
 * expands to just that entry: its helper modules sit beside the index and must
 * not be loaded as separate extensions. Only a directory without an index is a
 * container of extensions and gets scanned. Anything else is taken as a literal
 * entry file so a mistyped path still reaches the host and is reported as a
 * load issue rather than vanishing.
 */
function expandExplicitPath(path: string, cwd: string) {
  const homeExpanded = expandHomePath(path);
  const resolvedPath = isAbsolute(homeExpanded)
    ? resolve(homeExpanded)
    : resolve(cwd, homeExpanded);

  if (!isDirectory(resolvedPath)) {
    return [resolvedPath];
  }

  const folderIndex = findFolderExtensionIndex(resolvedPath);
  return folderIndex ? [folderIndex] : scanExtensionsDir(resolvedPath);
}

/**
 * Discover extension entry files in a deterministic order.
 *
 * Groups run flag paths, user-config paths, the global directory, then
 * repo-local sources, alphabetically within each group. The first occurrence of
 * a resolved path wins, so a flag path keeps its `flag` origin (and its trust
 * exemption) even when the same file is also discovered repo-locally.
 */
export function discoverExtensions(options: DiscoverExtensionsOptions = {}): ExtensionCandidate[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? findVcsRepoRootCandidate(cwd);
  const globalExtensionsDir = options.globalExtensionsDir ?? resolveGlobalExtensionsDir(env);

  const groups: Array<{ origin: ExtensionOrigin; paths: string[] }> = [
    {
      origin: "flag",
      paths: (options.flagPaths ?? []).flatMap((path) => expandExplicitPath(path, cwd)),
    },
    {
      origin: "config",
      paths: (options.configPaths ?? []).flatMap((path) => expandExplicitPath(path, cwd)),
    },
    {
      origin: "global",
      paths: globalExtensionsDir ? scanExtensionsDir(globalExtensionsDir) : [],
    },
    {
      origin: "repo",
      paths: [
        ...(repoRoot ? scanExtensionsDir(join(repoRoot, ".hunk", "extensions")) : []),
        // Repo config contributes arbitrary paths, so treat them with the same
        // trust posture as `.hunk/extensions` rather than as user intent.
        ...(options.repoConfigPaths ?? []).flatMap((path) =>
          expandExplicitPath(path, repoRoot ?? cwd),
        ),
      ],
    },
  ];

  const candidates: ExtensionCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const group of groups) {
    for (const path of [...group.paths].sort((a, b) => a.localeCompare(b))) {
      if (seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      candidates.push({ id: deriveExtensionId(path), path, origin: group.origin });
    }
  }

  return candidates;
}
