/**
 * fork/join extension — context-scoped fork/join for pi's session tree.
 *
 * `fork(label)` opens a child segment at the current leaf; work there stays
 * out of the parent's context. `join(message)` reports back: the leaf rewinds
 * to the fork root at the join turn's BOUNDARY (turn_end -> SessionManager
 * .branch + {entries, continue}), and the parent continues in the same run,
 * in every mode (incl. `pi -p`), seeing only report + generated manifest.
 * `child_call(id)` reads any manifest entry back in full. /abandon-fork
 * promotes a drifted child to mainline (human-only). /forkjoin-commit is the
 * idle/crash recovery path. Live-fork state is derived purely by walking the
 * active branch (fork-open | join | cancel | abandon | root) — no extension
 * state. Design + evidence: see DECISIONS.md / README.md alongside this file.
 *
 * Debug: set FORKJOIN_DEBUG=1 to enable stderr logging and the test-only
 * `probe` tool. Verified against pi 1.3.0.
 */
import { Type } from "@earendil-works/pi-ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const FORK_OPEN_PREFIX = "FORK OPEN";
const CUSTOM_STAGED = "forkjoin/staged";
const CUSTOM_ABANDON = "forkjoin/abandon";
const CUSTOM_JOIN = "forkjoin/join"; // custom_message (context-visible)
const CUSTOM_CANCEL = "forkjoin/cancel"; // boundary-cancel note (terminal for the staged join)

type WalkState = "fork" | "join" | "abandon" | "root";

interface WalkResult {
	state: WalkState;
	/** fork-open toolResult entry id when state==="fork" */
	forkRootEntryId?: string;
	forkLabel?: string;
}

/** Walk the active branch backward from the leaf to the first fork/join marker. */
function walkForkState(ctx: ExtensionContext): WalkResult {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as any;
		if (e.type === "custom_message" && e.customType === CUSTOM_JOIN) return { state: "join" };
		if (e.type === "custom" && e.customType === CUSTOM_ABANDON) return { state: "abandon" };
		if (e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "fork") {
			const text = resultText(e.message);
			if (text.startsWith(FORK_OPEN_PREFIX)) {
				return {
					state: "fork",
					forkRootEntryId: e.id,
					forkLabel: text.slice(FORK_OPEN_PREFIX.length + 2).split("\n")[0],
				};
			}
		}
	}
	return { state: "root" };
}

function resultText(m: any): string {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("");
	return "";
}

/** Feature gate: v1 requires SessionManager.branch (public method; absence = old pi). */
const branchAvailable = (sm: any) => typeof sm?.branch === "function";

/** Is our toolCall the only tool call in its assistant message? (branch must already contain it) */
function isExclusiveCall(ctx: ExtensionContext, toolCallId: string): { exclusive: boolean; checked: boolean; siblings: number; asstEntryId: string | null } {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as any;
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const calls = (e.message.content ?? []).filter((b: any) => b?.type === "toolCall");
		if (calls.some((c: any) => c.id === toolCallId)) {
			return { exclusive: calls.length === 1, checked: true, siblings: calls.length, asstEntryId: e.id };
		}
	}
	return { exclusive: false, checked: false, siblings: -1, asstEntryId: null };
}

const err = (reason: string) => ({
	content: [{ type: "text" as const, text: reason }],
	details: { ok: false },
	isError: true,
});
const ok = (text: string, details?: unknown) => ({
	content: [{ type: "text" as const, text }],
	details: { ok: true, ...(details as any) },
});

// ---- manifest rendering (generated evidence) ----
function oneLine(e: any): string | null {
	const m = (e as any).message;
	if (e.type !== "message" || !m) return null;
	if (m.role === "assistant") {
		const parts: string[] = [];
		for (const b of m.content ?? []) {
			if (b?.type === "toolCall") {
				if (b.name === "join") continue; // the in-flight join is not child evidence
				const args = b.arguments ?? {};
				const detail = args.command ?? args.path ?? args.file_path ?? JSON.stringify(args).slice(0, 60);
				parts.push(`call ${b.name}: ${String(detail).replace(/\s+/g, " ").slice(0, 100)}`);
			} else if (b?.type === "text" && b.text?.trim()) {
				parts.push(`say: ${b.text.replace(/\s+/g, " ").slice(0, 80)}`);
			}
		}
		return parts.length ? parts.join(" | ") : null;
	}
	if (m.role === "toolResult") {
		const t = resultText(m).replace(/\s+/g, " ").slice(0, 90);
		return `  -> ${m.toolName} [${e.id}]${m.isError ? " ERROR" : ""}: ${t}`;
	}
	if (m.role === "user") return `user: ${resultText(m).replace(/\s+/g, " ").slice(0, 80)}`;
	return null;
}

function buildManifest(ctx: ExtensionContext, forkRootEntryId: string): string {
	const branch = ctx.sessionManager.getBranch();
	const start = branch.findIndex((e: any) => e.id === forkRootEntryId);
	const lines: string[] = [];
	let last: string | null = null;
	let repeat = 0;
	const push = (l: string) => {
		if (l === last) repeat++;
		else {
			if (last !== null) lines.push(repeat ? `${last}  (x${repeat + 1})` : last);
			last = l;
			repeat = 0;
		}
	};
	for (let i = start + 1; i < branch.length; i++) {
		const e: any = branch[i];
		if (e.type === "message" && e.message?.role === "toolResult" && (e.message?.toolName === "read" || e.message?.toolName === "join")) continue; // reads + own acks suppressed
		const l = oneLine(e);
		if (l) push(l);
	}
	if (last !== null) lines.push(repeat ? `${last}  (x${repeat + 1})` : last);
	const CAP = 60;
	// Error lines float: they are never elided by the cap.
	const isErr = (l: string) => /\] ERROR:/.test(l);
	const normal = lines.filter((l) => !isErr(l));
	const errs = lines.filter(isErr);
	const shown = normal.slice(0, CAP);
	if (normal.length > CAP) shown.push(`(${normal.length - CAP} non-error lines elided; ${errs.length} error lines retained)`);
	shown.push(...errs);
	return shown.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Debug output env-gated: raw stderr writes corrupt the TUI display, and
	// the test-only probe tool must not occupy the production tool list.
	const DEBUG = !!process.env.FORKJOIN_DEBUG;
	const log = (...a: unknown[]) => {
		if (DEBUG) console.error("[forkjoin]", ...a);
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	// settle waiters: agent_settled is the final boundary (post-run leaf restoration done).
	const settledWaiters: (() => void)[] = [];
	pi.on("agent_settled", () => {
		for (const w of settledWaiters.splice(0)) w();
	});

	// ---------------- fork ----------------
	const forkTool = defineTool({
		name: "fork",
		label: "Fork",
		description: "Open a forked child segment. Must be the ONLY tool call in the turn. Call join when done.",
		parameters: Type.Object({ label: Type.String({ description: "short noun phrase" }) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!branchAvailable(ctx.sessionManager))
				return err("fork: unavailable on this pi build (SessionManager.branch missing); fork/join disabled to avoid unsound state");
			const ex = isExclusiveCall(ctx, toolCallId);
			if (!ex.checked) return err("fork: internal error — own assistant message not found; not opening a fork");
			if (!ex.exclusive)
				return err(`fork must be the only tool call in its turn (saw ${ex.siblings} calls). Put other tool work in previous turns.`);
			const w = walkForkState(ctx);
			if (w.state === "fork") {
				// State-dependent diagnostic: report EVIDENCE, not just the verdict
				// (chess-session incident: a bare "still open" lost to a confident
				// false memory of a join that never happened).
				const branch = ctx.sessionManager.getBranch() as any[];
				const start = branch.findIndex((e) => e.id === w.forkRootEntryId);
				let stagedSeen = false;
				let calls = 0;
				let lastAction = "";
				let mutated = false;
				for (let i = start + 1; i < branch.length; i++) {
					const e: any = branch[i];
					if (e.type === "custom" && e.customType === CUSTOM_STAGED) stagedSeen = true;
					if (e.type === "message" && e.message?.role === "toolResult") {
						calls++;
						const tn: string = e.message.toolName ?? "?";
						if (tn === "edit" || tn === "write") mutated = true;
						lastAction = `${tn}: ${resultText(e.message).replace(/\s+/g, " ").slice(0, 140)}`;
					}
				}
				const state = stagedSeen
					? "a join WAS STAGED for it but never committed (the join turn was likely aborted or errored); calling join again re-stages and commits at the next turn boundary"
					: "NO JOIN WAS EVER CALLED for it (nothing staged, no join note above the fork point)";
				const evidence = calls > 0 ? ` Child did ${calls} tool call(s); most recent result -> ${lastAction}.` : " The child has done nothing since the fork opened.";
				// Ask-the-user hints only where a user can answer (TUI/RPC); in print
				// mode such advice ends the run with the fork stuck open.
				const exit = ctx.hasUI
					? ` Call join(message) alone in a turn to report and rewind${mutated ? " (account for the child's file mutations in the report)" : ""}; if the child drifted into real mainline work, ask the user to run /abandon-fork.`
					: ` Call join(message) alone in a turn to report and rewind${mutated ? " — account for the child's file mutations in the report" : ""}.`;
				return err(`fork "${w.forkLabel}" is still open: ${state}.${evidence}${exit}`);
			}
			// /tree findability for live forks (best-effort).
			if (ex.asstEntryId && typeof (pi as any).setLabel === "function") {
				try {
					(pi as any).setLabel(ex.asstEntryId, `fork: ${params.label}`);
				} catch {
					/* label is cosmetic */
				}
			}
			const root = ctx.sessionManager.getLeafId();
			log(`fork opened label=${JSON.stringify(params.label)} parentLeaf=${root}`);
			return ok(`${FORK_OPEN_PREFIX}: ${params.label}\nThe session proceeds here as a child segment. Work, then call join(message) alone in a turn.`, {
				label: params.label,
				parentLeaf: root,
			});
		},
	});

	// ---------------- join ----------------
	const joinTool = defineTool({
		name: "join",
		label: "Join",
		description: "Report back to the fork's parent. Must be the ONLY tool call in the turn.",
		parameters: Type.Object({ message: Type.String({ description: "freeform report" }) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!branchAvailable(ctx.sessionManager))
				return err("join: unavailable on this pi build (SessionManager.branch missing); use /forkjoin-commit recovery only");
			const ex = isExclusiveCall(ctx, toolCallId);
			if (!ex.exclusive)
				return err(`join must be the only tool call in its turn (saw ${ex.siblings}). Run other tools first, then join alone.`);
			const w = walkForkState(ctx);
			if (w.state !== "fork" || !w.forkRootEntryId) return err(`no active fork to join (walk reached: ${w.state})`);
			const manifest = buildManifest(ctx, w.forkRootEntryId);
			// Direct manager append: durable immediately (crash-safe) and visible to
			// this turn's turn_end handler (bypasses run-time custom-message queueing).
			(ctx.sessionManager as any).appendCustomEntry(CUSTOM_STAGED, {
				forkRootEntryId: w.forkRootEntryId,
				forkLabel: w.forkLabel,
				message: params.message,
				manifest,
				stampedAt: new Date().toISOString(),
			});
			log("join staged; boundary commit will fire at this turn's turn_end");
			return ok("join staged; commit at turn boundary; this segment ends and the parent continues.", { staged: true });
		},
	});

	// ---------------- boundary commit (v2 PRIMARY path) ----------------
	// turn_end fires only after the assistant message AND every tool result are
	// appended — the first point where moving the leaf cannot strand a tool_use.
	// Entries returned from this handler commit AFTER our branch() side effect
	// (so the note lands on the NEW/parent branch) and BEFORE the steering
	// drain; continue:true guarantees the parent continuation request inside
	// the same prompt() — every mode, including print. Request contexts are
	// rebuilt from the tree projection by pi core, so no context handler and no
	// agent.state repair are needed.
	function joinNoteText(staged: any): string {
		return `[join ${staged.forkLabel ?? ""}]
${staged.message}

--- child tool calls (evidence) ---
${staged.manifest}

(Any listed [id] can be read back in full via child_call(id); child entries persist in the session tree.)`;
	}

	pi.on("turn_end" as any, async (event: any, ctx: any) => {
		const sm = ctx.sessionManager;
		const branch = sm.getBranch() as any[];
		const last = branch[branch.length - 1];
		// Only the join turn's own end looks like this: leaf is join's ack result.
		if (!(last?.type === "message" && last.message?.role === "toolResult" && last.message?.toolName === "join")) return;
		if (last.message.isError) return; // rejected join (not exclusive / no fork) must never commit
		const msg = event?.message;
		if (msg?.stopReason === "aborted" || msg?.stopReason === "error") {
			log("join turn ended aborted/error; staged join left for /forkjoin-commit");
			return;
		}
		// Walk back to staged; a prior join/cancel note short-circuits (idempotent).
		let staged: any;
		let stagedIdx = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom_message" && (e.customType === CUSTOM_JOIN || e.customType === CUSTOM_CANCEL)) return;
			if (e.type === "custom" && e.customType === CUSTOM_STAGED) {
				staged = e.data;
				stagedIdx = i;
				break;
			}
		}
		if (!staged) return;
		const forkIdx = branch.findIndex((e: any) => e.id === staged.forkRootEntryId);
		// Preserve other extensions' boundary drafts: pi CHAINS the entries list
		// (each handler sees the accumulated list and REPLACES it) — never drop
		// others' drafts. Drop stale context_edit drafts and our own stale notes.
		const kept = ((event?.entries ?? []) as any[]).filter((d) => {
			if (!d || typeof d !== "object") return false;
			if (d.details?.forkjoin) return false;
			if (d.type === "context_edit" && d.targetId && !sm.getEntry(d.targetId)) return false;
			return true;
		});
		const note = (text: string, type: string) => ({
			entries: [
				...kept,
				{
					type: "custom_message",
					customType: type,
					content: [{ type: "text", text }],
					display: true,
					details: { forkRootEntryId: staged.forkRootEntryId, forkjoin: true },
				},
			],
			continue: true,
		});
		if (forkIdx === -1 || forkIdx > stagedIdx) {
			log("join cancelled: fork root not on active branch below staged");
			return note(`[join ${staged.forkLabel ?? ""} CANCELLED] fork root is no longer on the active branch; child work remains reachable in /tree.`, CUSTOM_CANCEL);
		}
		try {
			sm.branch(staged.forkRootEntryId);
		} catch (branchErr) {
			return note(`[join ${staged.forkLabel ?? ""} CANCELLED] could not branch to fork root: ${(branchErr as Error).message}`, CUSTOM_CANCEL);
		}
		log(`boundary commit: leaf moved to fork root ${staged.forkRootEntryId}`);
		return note(joinNoteText(staged), CUSTOM_JOIN);
	});

	// ---------------- child_call (readback; safe in batches, pure read) ----------------
	const childCallTool = defineTool({
		name: "child_call",
		label: "Child call",
		description: "Read back one full child-segment tool call (args, thinking, full result) by manifest entry id.",
		parameters: Type.Object({ id: Type.String({ description: "entry id shown as [xxxxxxxx] in a join manifest" }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager as any;
			const entry = sm.getEntry(params.id);
			if (!entry) return err(`child_call: no entry ${params.id} in this session (pruned or bad id)`);
			const m = entry.message;
			if (!(entry.type === "message" && m?.role === "toolResult")) return err("child_call: id must reference a tool-result entry (manifest ids of the form [xxxxxxxx])");
			const parent = sm.getEntry(entry.parentId);
			const parts: string[] = [];
			if (parent?.message?.role === "assistant") {
				for (const b of parent.message.content ?? []) {
					if (b?.type === "thinking") parts.push(`[thinking] ${b.thinking ?? b.text ?? ""}`);
					else if (b?.type === "toolCall" && (b.id === m.toolCallId || b.name === m.toolName)) parts.push(`[args ${b.name}] ${JSON.stringify(b.arguments ?? {}, null, 1)}`);
				}
			}
			// Lineage stamp: which fork did this call belong to?
			let lineage = "unknown";
			for (let cur = entry; cur; cur = sm.getEntry(cur.parentId)) {
				if (cur.type === "message" && cur.message?.role === "toolResult" && cur.message?.toolName === "fork" && resultText(cur.message).startsWith(FORK_OPEN_PREFIX)) {
					lineage = resultText(cur.message).slice(FORK_OPEN_PREFIX.length + 2).split("\n")[0];
					break;
				}
			}
			parts.push(`[result${m.isError ? " ERROR" : ""}] ${resultText(m)}`);
			const full = `[child_call ${params.id} fork:${lineage}]\n${parts.join("\n\n")}`;
			const BUDGET = 4000;
			const bytes = Buffer.byteLength(full, "utf8");
			if (bytes <= BUDGET) return ok(full, { id: params.id, lineage, bytes, spilled: null });
			try {
				const dir = join(process.cwd(), ".forkjoin");
				mkdirSync(dir, { recursive: true });
				const file = join(dir, `readback-${params.id}.txt`);
				writeFileSync(file, full, "utf8");
				return ok(`${full.slice(0, BUDGET)}\n...[spilled ${bytes} bytes]\nFULL: ${file}`, { id: params.id, lineage, bytes, spilled: file });
			} catch (ioErr) {
				return ok(`${full.slice(0, BUDGET)}\n...[truncated ${bytes} bytes; spill failed: ${(ioErr as Error).message}]`, { id: params.id, lineage, bytes, spilled: null });
			}
		},
	});

	// ---------------- probe tool (exclusivity sibling) ----------------
	const probeTool = defineTool({
		name: "probe",
		label: "Probe",
		description: "No-op marker that does real work for exclusivity tests.",
		parameters: Type.Object({ note: Type.String() }),
		async execute(_id, params) {
			log(`probe ran: ${params.note}`);
			return ok(`probe: ${params.note}`, { note: params.note });
		},
	});

	pi.registerTool(forkTool);
	pi.registerTool(joinTool);
	pi.registerTool(childCallTool);
	if (DEBUG) pi.registerTool(probeTool); // test-only marker, hidden in production

	// ---------------- commit command (IDLE RECOVERY path) ----------------
	// v2 demotes this from primary to recovery: commits a staged join left
	// uncommitted by an abort/crash, and serves multi-invocation flows. Runs
	// with ExtensionCommandContext: waitForIdle + navigateTree are command-only.
	pi.registerCommand("forkjoin-commit", {
		description: "Recovery: commit a staged fork join that never landed",
		handler: async (_args, ctx) => {
			log("commit command invoked");
			// Find staged payload: most recent staged entry on the ACTIVE branch.
			const branch = ctx.sessionManager.getBranch() as any[];
			let staged: any = undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "custom" && e.customType === CUSTOM_STAGED) {
					staged = e.data;
					break;
				}
				if (e.type === "custom_message" && (e.customType === CUSTOM_JOIN || e.customType === CUSTOM_CANCEL)) break; // already joined/cancelled below this staging
			}
			if (!staged) {
				log("commit: nothing staged");
				return;
			}
			// Wait for the child run to fully settle. waitForIdle resolves at stream end;
			// run-completion handling can restore the leaf AFTER that, undoing our navigate.
			// agent_settled is the final boundary — wait for it when a run is active.
			if (!ctx.isIdle()) {
				await Promise.race([
					new Promise<void>((res) => settledWaiters.push(res)),
					ctx.waitForIdle().then(() => sleep(250)),
					new Promise<void>((r) => setTimeout(r, 10_000)),
				]);
			} else {
				await ctx.waitForIdle();
			}
			log(`commit: settled; leaf=${ctx.sessionManager.getLeafId()} want=${staged.forkRootEntryId}`);
			// Navigate with verify-retry: leaf may still be restored by late settle work.
			if (typeof (ctx as any).navigateTree !== "function") {
				const msg = "forkjoin-commit: this host does not expose navigation; join remains staged";
				log(msg);
				(ctx as any).ui?.notify?.(msg, { type: "error" });
				return;
			}
			let arrived = false;
			for (let attempt = 0; attempt < 6 && !arrived; attempt++) {
				let nav: { cancelled: boolean };
				try {
					nav = await ctx.navigateTree(staged.forkRootEntryId, {
						summarize: false,
						label: attempt === 0 ? `join:${staged.forkLabel ?? "?"}` : undefined,
					});
				} catch (navErr) {
					const msg = `forkjoin-commit: navigation failed (${(navErr as Error).message}); join remains staged`;
					log(msg);
					(ctx as any).ui?.notify?.(msg, { type: "error" });
					return;
				}
				if (nav.cancelled) {
					log("commit: navigation cancelled");
					return;
				}
				await sleep(40);
				const b2 = ctx.sessionManager.getBranch() as any[];
				const last = b2[b2.length - 1];
				arrived = !!last && (last.id === staged.forkRootEntryId || last.parentId === staged.forkRootEntryId);
				if (!arrived) log(`commit: leaf drifted to ${last?.id} after navigate (attempt ${attempt})`);
			}
			log(`commit: navigated to fork root (arrived=${arrived})`);
			if (!arrived) {
				// Hard-fail, never mis-land: unbound/silently-stubbed navigation is a
				// known hazard; a note at the wrong leaf would corrupt the transcript.
				const msg = "forkjoin-commit: navigation to the fork root did not take effect; aborting (join remains staged — retry when the host supports navigation)";
				log(msg);
				( ctx as any).ui?.notify?.(msg, { type: "error" });
				return;
			}
			const text = joinNoteText(staged);
			// Context-visible join note; triggerTurn resumes the parent line of thought.
			if (typeof (pi as any).sendMessage === "function") {
				await (pi as any).sendMessage(
					{ customType: CUSTOM_JOIN, content: [{ type: "text", text }], display: true },
					{ triggerTurn: true },
				);
				log("commit: join note delivered, parent turn triggered");
			} else {
				await (ctx as any).sendUserMessage?.(text, { expandPromptTemplates: false });
				log("commit: sendMessage unavailable; join note sent as user message");
			}
		},
	});

	// ---------------- abandon command (human-only) ----------------
	pi.registerCommand("abandon-fork", {
		description: "Void the active fork; child continues as linear session",
		handler: async (args, ctx) => {
			const w = walkForkState(ctx);
			if (w.state !== "fork") {
				log(`abandon: no active fork (walk reached: ${w.state})`);
				return;
			}
			// Direct append: deterministic landing even if invoked mid-stream
			// (pi.appendEntry queues until the turn_end flush, which can land AFTER
			// a same-turn boundary commit).
			(ctx.sessionManager as any).appendCustomEntry(CUSTOM_ABANDON, { forkRootEntryId: w.forkRootEntryId, note: args || undefined, at: new Date().toISOString() });
			log(`abandon: fork voided (${w.forkLabel}); child continues as mainline. note=${args || ""}`);
		},
	});
}
