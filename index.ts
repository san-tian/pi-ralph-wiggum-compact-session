/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getPiProjectSubdir } from "@san-tian/pi-project-paths";

const RALPH_DIR = path.join(".pi", "ralph");
const LEGACY_RALPH_DIR = ".ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";
const RALPH_COMPACT_INSTRUCTIONS = `This compaction is for a Ralph loop iteration handoff inside the same session.

Preserve:
- the task goal and checklist progress
- completed work, blockers, and verification evidence
- important code decisions and files touched
- the most important next actions for the next iteration

Keep the summary concise and action-oriented.`;

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Notes
(Update this as you work)
`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";

interface LoopState {
	name: string;
	taskFile: string;
	iteration: number;
	maxIterations: number;
	itemsPerIteration: number; // Prompt hint only - "process N items per turn"
	reflectEvery: number; // Reflect every N iterations
	reflectInstructions: string;
	active: boolean; // Backwards compat
	status: LoopStatus;
	ownerSession: string | null;
	startedAt: string;
	completedAt?: string;
	lastReflectionAt: number; // Last iteration we reflected at
	pendingContinuation: boolean; // Waiting for compaction before queueing next iteration
}

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };

export default function (pi: ExtensionAPI) {
	let currentLoop: string | null = null;
	let runtimeSessionKey: string | null = null;

	// --- File helpers ---

	const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");

	function tryCleanupPath(targetPath: string): void {
		try {
			const stats = fs.statSync(targetPath);
			if (stats.isDirectory()) {
				fs.rmSync(targetPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(targetPath);
			}
		} catch {
			/* ignore */
		}
	}

	function tryMovePath(srcPath: string, dstPath: string): boolean {
		if (!fs.existsSync(srcPath) || fs.existsSync(dstPath)) return false;

		try {
			fs.mkdirSync(path.dirname(dstPath), { recursive: true });
			fs.renameSync(srcPath, dstPath);
			return true;
		} catch {
			/* fall back to copy + delete */
		}

		try {
			const stats = fs.statSync(srcPath);
			fs.mkdirSync(path.dirname(dstPath), { recursive: true });
			if (stats.isDirectory()) {
				fs.cpSync(srcPath, dstPath, { recursive: true, errorOnExist: true });
				fs.rmSync(srcPath, { recursive: true, force: true });
			} else {
				fs.copyFileSync(srcPath, dstPath);
				fs.unlinkSync(srcPath);
			}
			return true;
		} catch {
			tryCleanupPath(dstPath);
			return false;
		}
	}

	const ralphDir = (ctx: ExtensionContext) => {
		const nextDir = getPiProjectSubdir(ctx.cwd, "ralph");
		const projectLocalDir = path.resolve(ctx.cwd, RALPH_DIR);
		const legacyDir = path.resolve(ctx.cwd, LEGACY_RALPH_DIR);
		if (!fs.existsSync(nextDir)) {
			if (fs.existsSync(projectLocalDir)) {
				tryMovePath(projectLocalDir, nextDir);
			} else if (fs.existsSync(legacyDir)) {
				tryMovePath(legacyDir, nextDir);
			}
		}
		if (fs.existsSync(nextDir)) return nextDir;
		if (fs.existsSync(projectLocalDir)) return projectLocalDir;
		if (fs.existsSync(legacyDir)) return legacyDir;
		return nextDir;
	};
	const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
	const isManagedTaskFile = (ctx: ExtensionContext, name: string, taskFile: string) => {
		const fileName = `${sanitize(name)}.md`;
		const resolvedTaskFile = path.resolve(ctx.cwd, taskFile);
		const managedLocations = [
			path.resolve(ctx.cwd, path.join(RALPH_DIR, fileName)),
			path.resolve(ctx.cwd, path.join(LEGACY_RALPH_DIR, fileName)),
			getPath(ctx, name, ".md"),
			getPath(ctx, name, ".md", true),
		];
		return managedLocations.includes(resolvedTaskFile);
	};
	const normalizeTaskFile = (ctx: ExtensionContext, name: string, taskFile: string | undefined, archived = false) => {
		if (!taskFile) return getPath(ctx, name, ".md", archived);
		if (isManagedTaskFile(ctx, name, taskFile)) return getPath(ctx, name, ".md", archived);
		return taskFile;
	};
	const getSessionOwner = (ctx: ExtensionContext) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) return sessionFile;
		if (!runtimeSessionKey) {
			runtimeSessionKey = `ephemeral:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
		}
		return runtimeSessionKey;
	};

	function isOwnedByCurrentSession(ctx: ExtensionContext, state: LoopState): boolean {
		return state.ownerSession === getSessionOwner(ctx);
	}

	function clearCurrentLoop(ctx: ExtensionContext): void {
		if (!currentLoop) return;
		currentLoop = null;
		updateUI(ctx);
	}

	function getCurrentOwnedLoopState(ctx: ExtensionContext): LoopState | null {
		if (!currentLoop) return null;
		const state = loadState(ctx, currentLoop);
		if (!state || state.status !== "active" || !isOwnedByCurrentSession(ctx, state)) {
			clearCurrentLoop(ctx);
			return null;
		}
		return state;
	}

	function pauseCurrentLoopForSwitch(ctx: ExtensionContext, nextLoopName: string, reason?: string): void {
		if (!currentLoop || currentLoop === nextLoopName) return;
		const current = loadState(ctx, currentLoop);
		if (!current) {
			clearCurrentLoop(ctx);
			return;
		}
		if (current.status === "active" && isOwnedByCurrentSession(ctx, current)) {
			pauseLoop(ctx, current, reason);
			return;
		}
		clearCurrentLoop(ctx);
	}

	function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		return path.join(dir, `${sanitize(name)}${ext}`);
	}

	function ensureDir(filePath: string): void {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}

	function tryDelete(filePath: string): void {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}

	function tryRead(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	function tryRemoveDir(dirPath: string): boolean {
		try {
			if (fs.existsSync(dirPath)) {
				fs.rmSync(dirPath, { recursive: true, force: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	// --- State management ---

	function migrateState(ctx: ExtensionContext, raw: Partial<LoopState> & { name: string }, archived = false): LoopState {
		if (!raw.status) raw.status = raw.active ? "active" : "paused";
		raw.active = raw.status === "active";
		if (raw.pendingContinuation === undefined) raw.pendingContinuation = false;
		if (raw.ownerSession === undefined) raw.ownerSession = null;
		raw.taskFile = normalizeTaskFile(ctx, raw.name, raw.taskFile, archived);
		// Migrate old field names
		if ("reflectEveryItems" in raw && !raw.reflectEvery) {
			raw.reflectEvery = (raw as any).reflectEveryItems;
		}
		if ("lastReflectionAtItems" in raw && raw.lastReflectionAt === undefined) {
			raw.lastReflectionAt = (raw as any).lastReflectionAtItems;
		}
		return raw as LoopState;
	}

	function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
		const content = tryRead(getPath(ctx, name, ".state.json", archived));
		if (!content) return null;
		try {
			return migrateState(ctx, JSON.parse(content), archived);
		} catch {
			return null;
		}
	}

	function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
		state.active = state.status === "active";
		state.taskFile = normalizeTaskFile(ctx, state.name, state.taskFile, archived);
		const filePath = getPath(ctx, state.name, ".state.json", archived);
		ensureDir(filePath);
		fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
	}

	function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
		const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".state.json"))
			.map((f) => {
				const content = tryRead(path.join(dir, f));
				if (!content) return null;
				try {
					return migrateState(ctx, JSON.parse(content), archived);
				} catch {
					return null;
				}
			})
			.filter((s): s is LoopState => s !== null);
	}

	// --- Loop state transitions ---

	function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "paused";
		state.active = false;
		state.pendingContinuation = false;
		state.ownerSession = null;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	function completeLoop(ctx: ExtensionContext, state: LoopState, banner: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		state.pendingContinuation = false;
		state.ownerSession = null;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		pi.sendUserMessage(banner);
	}

	function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.active = false;
		state.pendingContinuation = false;
		state.ownerSession = null;
		saveState(ctx, state);
		currentLoop = null;
		updateUI(ctx);
		if (message && ctx.hasUI) ctx.ui.notify(message, "info");
	}

	// --- UI ---

	function formatLoop(l: LoopState): string {
		const status = `${STATUS_ICONS[l.status]} ${l.status}`;
		const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
		const pending = l.pendingContinuation ? " | compacting" : "";
		const owner = l.status === "active" ? ` | ${l.ownerSession ? "claimed" : "unclaimed"}` : "";
		return `${l.name}: ${status}${pending}${owner} (iteration ${iter})`;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const state = currentLoop ? loadState(ctx, currentLoop) : null;
		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const pending = state.pendingContinuation ? " | compacting" : "";

		ctx.ui.setStatus("ralph", theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr}${pending})`));

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${STATUS_ICONS[state.status]} ${state.status}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];
		if (state.pendingContinuation) {
			lines.push(theme.fg("warning", "Phase: compacting current session before next iteration"));
		}
		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
		}
		// Warning about stopping
		lines.push("");
		lines.push(theme.fg("warning", "ESC pauses the assistant"));
		lines.push(theme.fg("warning", "Send a message to resume; /ralph-stop ends the loop"));
		ctx.ui.setWidget("ralph", lines);
	}

	// --- Prompt building ---

	function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

		const parts = [header, ""];
		if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

		parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
		parts.push(`\n## Instructions\n`);
		parts.push("User controls: ESC pauses the assistant. Send a message to resume. Run /ralph-stop when idle to stop the loop.\n");
		parts.push(
			`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
		);

		if (state.itemsPerIteration > 0) {
			parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`);
			parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
		} else {
			parts.push(`1. Continue working on the task`);
		}
		parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
		parts.push(`3. When FULLY COMPLETE, respond with: ${COMPLETE_MARKER}`);
		parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

		return parts.join("\n");
	}

	function shouldReflect(state: LoopState): boolean {
		return state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
	}

	function isAbortError(error: unknown): boolean {
		const name = error instanceof Error ? error.name : "";
		const message = error instanceof Error ? error.message : String(error ?? "");
		return /abort/i.test(name) || /abort|cancel/i.test(message);
	}

	function queueNextIteration(ctx: ExtensionContext, state: LoopState): { ok: boolean; text: string } {
		const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
		if (!content) {
			pauseLoop(ctx, state);
			return { ok: false, text: `Error: Could not read task file: ${state.taskFile}` };
		}

		pi.sendUserMessage(buildPrompt(state, content, shouldReflect(state)), { deliverAs: "followUp" });
		return {
			ok: true,
			text: `Iteration ${state.iteration - 1} complete. Next iteration queued.`,
		};
	}

	// --- Arg parsing ---

	function parseArgs(argsStr: string) {
		const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
		const result = {
			name: "",
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
			takeover: false,
		};

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			const next = tokens[i + 1];
			if (tok === "--max-iterations" && next) {
				result.maxIterations = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--items-per-iteration" && next) {
				result.itemsPerIteration = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-every" && next) {
				result.reflectEvery = parseInt(next, 10) || 0;
				i++;
			} else if (tok === "--reflect-instructions" && next) {
				result.reflectInstructions = next.replace(/^"|"$/g, "");
				i++;
			} else if (tok === "--takeover") {
				result.takeover = true;
			} else if (!tok.startsWith("--")) {
				result.name = tok;
			}
		}
		return result;
	}

	// --- Commands ---

	const commands: Record<string, (rest: string, ctx: ExtensionContext) => void> = {
		start(rest, ctx) {
			const args = parseArgs(rest);
			if (!args.name) {
				ctx.ui.notify(
					"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
					"warning",
				);
				return;
			}

			const isPath = args.name.includes("/") || args.name.includes("\\");
			const loopName = isPath ? sanitize(path.basename(args.name, path.extname(args.name))) : args.name;
			const taskFile = isPath ? args.name : getPath(ctx, loopName, ".md");

			pauseCurrentLoopForSwitch(ctx, loopName, `Paused Ralph loop: ${currentLoop} (starting ${loopName})`);

			const existing = loadState(ctx, loopName);
			if (existing?.status === "active") {
				ctx.ui.notify(`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`, "warning");
				return;
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			if (!fs.existsSync(fullPath)) {
				ensureDir(fullPath);
				fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
				ctx.ui.notify(`Created task file: ${taskFile}`, "info");
			}

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: args.maxIterations,
				itemsPerIteration: args.itemsPerIteration,
				reflectEvery: args.reflectEvery,
				reflectInstructions: args.reflectInstructions,
				active: true,
				status: "active",
				ownerSession: getSessionOwner(ctx),
				startedAt: existing?.startedAt || new Date().toISOString(),
				lastReflectionAt: 0,
				pendingContinuation: false,
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			const content = tryRead(fullPath);
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${taskFile}`, "error");
				return;
			}
			pi.sendUserMessage(buildPrompt(state, content, false));
		},

		stop(_rest, ctx) {
			const state = getCurrentOwnedLoopState(ctx);
			if (!state) {
				ctx.ui.notify("No active Ralph loop in this session", "warning");
				return;
			}
			pauseLoop(ctx, state, `Paused Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},

		resume(rest, ctx) {
			const args = parseArgs(rest);
			const loopName = args.name.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph resume <name> [--takeover]", "warning");
				return;
			}

			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "completed") {
				ctx.ui.notify(`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`, "warning");
				return;
			}

			if (state.status === "active" && state.ownerSession && !isOwnedByCurrentSession(ctx, state) && !args.takeover) {
				ctx.ui.notify(`Loop "${loopName}" is active in another session. Use /ralph resume ${loopName} --takeover to claim it here.`, "warning");
				return;
			}

			pauseCurrentLoopForSwitch(ctx, loopName);

			state.status = "active";
			state.active = true;
			state.ownerSession = getSessionOwner(ctx);
			state.pendingContinuation = false;
			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			ctx.ui.notify(`Resumed: ${loopName} (iteration ${state.iteration})`, "info");

			const content = tryRead(path.resolve(ctx.cwd, state.taskFile));
			if (!content) {
				ctx.ui.notify(`Could not read task file: ${state.taskFile}`, "error");
				return;
			}

			const needsReflection = shouldReflect(state);
			pi.sendUserMessage(buildPrompt(state, content, needsReflection));
		},

		status(_rest, ctx) {
			const loops = listLoops(ctx);
			if (loops.length === 0) {
				ctx.ui.notify("No Ralph loops found.", "info");
				return;
			}
			ctx.ui.notify(`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		cancel(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
				return;
			}
			if (!loadState(ctx, loopName)) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (currentLoop === loopName) currentLoop = null;
			tryDelete(getPath(ctx, loopName, ".state.json"));
			ctx.ui.notify(`Cancelled: ${loopName}`, "info");
			updateUI(ctx);
		},

		archive(rest, ctx) {
			const loopName = rest.trim();
			if (!loopName) {
				ctx.ui.notify("Usage: /ralph archive <name>", "warning");
				return;
			}
			const state = loadState(ctx, loopName);
			if (!state) {
				ctx.ui.notify(`Loop "${loopName}" not found`, "error");
				return;
			}
			if (state.status === "active") {
				ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
				return;
			}

			if (currentLoop === loopName) currentLoop = null;

			const srcState = getPath(ctx, loopName, ".state.json");

			const srcTask = path.resolve(ctx.cwd, state.taskFile);
			if (srcTask.startsWith(ralphDir(ctx)) && !srcTask.startsWith(archiveDir(ctx))) {
				const dstTask = getPath(ctx, loopName, ".md", true);
				if (fs.existsSync(srcTask) && tryMovePath(srcTask, dstTask)) state.taskFile = dstTask;
			}

			saveState(ctx, state, true);
			tryDelete(srcState);

			ctx.ui.notify(`Archived: ${loopName}`, "info");
			updateUI(ctx);
		},

		clean(rest, ctx) {
			const all = rest.trim() === "--all";
			const completed = listLoops(ctx).filter((l) => l.status === "completed");

			if (completed.length === 0) {
				ctx.ui.notify("No completed loops to clean", "info");
				return;
			}

			for (const loop of completed) {
				tryDelete(getPath(ctx, loop.name, ".state.json"));
				if (all) tryDelete(getPath(ctx, loop.name, ".md"));
				if (currentLoop === loop.name) currentLoop = null;
			}

			const suffix = all ? " (all files)" : " (state only)";
			ctx.ui.notify(
				`Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
				"info",
			);
			updateUI(ctx);
		},

		list(rest, ctx) {
			const archived = rest.trim() === "--archived";
			const loops = listLoops(ctx, archived);

			if (loops.length === 0) {
				ctx.ui.notify(
					archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.",
					"info",
				);
				return;
			}

			const label = archived ? "Archived loops" : "Ralph loops";
			ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
		},

		nuke(rest, ctx) {
			const force = rest.trim() === "--yes";
			const dir = ralphDir(ctx);
			const warning = `This deletes all Ralph state, task, and archive files under ${dir}. External task files are not removed.`;

			const run = () => {
				if (!fs.existsSync(dir)) {
					if (ctx.hasUI) ctx.ui.notify("No Ralph storage directory found.", "info");
					return;
				}

				currentLoop = null;
				const ok = tryRemoveDir(dir);
				if (ctx.hasUI) {
					ctx.ui.notify(ok ? "Removed Ralph storage directory." : "Failed to remove Ralph storage directory.", ok ? "info" : "error");
				}
				updateUI(ctx);
			};

			if (!force) {
				if (ctx.hasUI) {
					void ctx.ui.confirm("Delete all Ralph loop files?", warning).then((confirmed) => {
						if (confirmed) run();
					});
				} else {
					ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			run();
		},
	};

	const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name> [--takeover]   Resume a paused loop or claim it from another session
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all managed Ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)
  --takeover               Claim a loop that is currently active in another session

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			const [cmd] = args.trim().split(/\s+/);
			const handler = commands[cmd];
			if (handler) {
				handler(args.slice(cmd.length).trim(), ctx);
			} else {
				ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop active Ralph loop (idle only)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
				}
				return;
			}

			const state = getCurrentOwnedLoopState(ctx);
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("No active Ralph loop in this session", "warning");
				return;
			}

			stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
		},
	});

	// --- Tool for agent self-invocation ---

	pi.registerTool({
		name: "ralph_start",
		label: "Start Ralph Loop",
		description: "Start a long-running development loop. Use for complex multi-iteration tasks.",
		promptSnippet: "Start a persistent multi-iteration development loop with pacing and reflection controls.",
		promptGuidelines: [
			"Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
			"After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
			taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
			itemsPerIteration: Type.Optional(Type.Number({ description: "Suggest N items per turn (0 = no limit)" })),
			reflectEvery: Type.Optional(Type.Number({ description: "Reflect every N iterations" })),
			maxIterations: Type.Optional(Type.Number({ description: "Max iterations (default: 50)", default: 50 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loopName = sanitize(params.name);
			const taskFile = getPath(ctx, loopName, ".md");

			pauseCurrentLoopForSwitch(ctx, loopName);

			if (loadState(ctx, loopName)?.status === "active") {
				return { content: [{ type: "text", text: `Loop "${loopName}" already active.` }], details: {} };
			}

			const fullPath = path.resolve(ctx.cwd, taskFile);
			ensureDir(fullPath);
			fs.writeFileSync(fullPath, params.taskContent, "utf-8");

			const state: LoopState = {
				name: loopName,
				taskFile,
				iteration: 1,
				maxIterations: params.maxIterations ?? 50,
				itemsPerIteration: params.itemsPerIteration ?? 0,
				reflectEvery: params.reflectEvery ?? 0,
				reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
				active: true,
				status: "active",
				ownerSession: getSessionOwner(ctx),
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
				pendingContinuation: false,
			};

			saveState(ctx, state);
			currentLoop = loopName;
			updateUI(ctx);

			pi.sendUserMessage(buildPrompt(state, params.taskContent, false), { deliverAs: "followUp" });

			return {
				content: [{ type: "text", text: `Started loop "${loopName}" (max ${state.maxIterations} iterations).` }],
				details: {},
			};
		},
	});

	// Tool for agent to signal iteration complete and request next
	pi.registerTool({
		name: "ralph_done",
		label: "Ralph Iteration Done",
		description: "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = getCurrentOwnedLoopState(ctx);
			if (!state) {
				return { content: [{ type: "text", text: "No active Ralph loop." }], details: {} };
			}

			if (state.pendingContinuation) {
				return {
					content: [{ type: "text", text: "Ralph loop is already compacting and preparing the next iteration." }],
					details: {},
				};
			}

			if (ctx.hasPendingMessages()) {
				return {
					content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }],
					details: {},
				};
			}

			// Increment iteration
			state.iteration++;

			// Check max iterations
			if (state.maxIterations > 0 && state.iteration > state.maxIterations) {
				completeLoop(
					ctx,
					state,
					`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
				);
				return { content: [{ type: "text", text: "Max iterations reached. Loop stopped." }], details: {} };
			}

			const needsReflection = shouldReflect(state);
			if (needsReflection) state.lastReflectionAt = state.iteration;
			state.pendingContinuation = true;

			saveState(ctx, state);
			updateUI(ctx);

			const loopName = state.name;
			ctx.compact({
				customInstructions: RALPH_COMPACT_INSTRUCTIONS,
				onComplete: () => {
					const latest = loadState(ctx, loopName);
					if (!latest || latest.status !== "active" || !latest.pendingContinuation) return;
					if (!isOwnedByCurrentSession(ctx, latest)) {
						clearCurrentLoop(ctx);
						return;
					}

					latest.pendingContinuation = false;
					saveState(ctx, latest);
					updateUI(ctx);

					const queued = queueNextIteration(ctx, latest);
					if (queued.ok && ctx.hasUI) {
						ctx.ui.notify(`Compacted Ralph loop "${loopName}" and queued iteration ${latest.iteration}.`, "info");
					}
				},
				onError: (error) => {
					const latest = loadState(ctx, loopName);
					if (!latest || !latest.pendingContinuation) return;
					if (!isOwnedByCurrentSession(ctx, latest)) {
						clearCurrentLoop(ctx);
						return;
					}

					latest.pendingContinuation = false;

					if (latest.status !== "active") {
						saveState(ctx, latest);
						updateUI(ctx);
						return;
					}

					if (isAbortError(error)) {
						pauseLoop(ctx, latest, `Paused Ralph loop: ${loopName} (compaction cancelled)`);
						return;
					}

					saveState(ctx, latest);
					updateUI(ctx);

					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Compaction failed for Ralph loop "${loopName}": ${message}. Continuing without compaction.`,
							"warning",
						);
					}

					queueNextIteration(ctx, latest);
				},
			});

			return {
				content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Compacting current session before next iteration.` }],
				details: {},
			};
		},
	});

	// --- Event handlers ---

	pi.on("before_agent_start", async (event, ctx) => {
		const state = getCurrentOwnedLoopState(ctx);
		if (!state) return;

		const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;

		let instructions = `You are in a Ralph loop working on: ${state.taskFile}\n`;
		if (state.itemsPerIteration > 0) {
			instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
		}
		instructions += `- Update the task file as you progress\n`;
		instructions += `- When FULLY COMPLETE: ${COMPLETE_MARKER}\n`;
		instructions += `- Otherwise, call ralph_done tool to proceed to next iteration`;

		return {
			systemPrompt: event.systemPrompt + `\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = getCurrentOwnedLoopState(ctx);
		if (!state) return;

		// Check for completion marker
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const text =
			lastAssistant && Array.isArray(lastAssistant.content)
				? lastAssistant.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
				: "";

		if (text.includes(COMPLETE_MARKER)) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Check max iterations
		if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
			completeLoop(
				ctx,
				state,
				`───────────────────────────────────────────────────────────────────────
⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached
───────────────────────────────────────────────────────────────────────`,
			);
			return;
		}

		// Don't auto-continue - let the agent call ralph_done to proceed
		// This allows user's "stop" message to be processed first
	});

	pi.on("session_start", async (_event, ctx) => {
		const owned = listLoops(ctx).filter((l) => l.status === "active" && isOwnedByCurrentSession(ctx, l));
		currentLoop = owned.length === 1 ? owned[0].name : null;
		if (owned.length > 1 && ctx.hasUI) {
			const lines = owned.map(
				(l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
			);
			ctx.ui.notify(`Multiple Ralph loops are attached to this session:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue one.`, "warning");
		}
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (currentLoop) {
			const state = loadState(ctx, currentLoop);
			if (state) saveState(ctx, state);
		}
	});
}
