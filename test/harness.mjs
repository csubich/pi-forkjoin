/**
 * fork/join spike harness — v2 (boundary-commit join).
 *
 * Runs a real pi AgentSession (in-memory SessionManager, isolated agentDir)
 * against a SCRIPTED provider registered via ModelRuntime.registerProvider.
 * No network, no global state, no real model.
 *
 * Key v2 assertions: the join turn's own turn_end commits (note lands on the
 * parent branch as child of the fork root, inside the same prompt()); the
 * parent continuation request is REBUILT from the tree (msgCount shrinks);
 * /forkjoin-commit recovers a staged join whose run died before the boundary.
 *
 * Usage: node harness.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";

const SPIKE = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.FORKJOIN_DEBUG = "1"; // harness needs probe tool + logs
const PKG_ROOT = process.env.PI_PKG_ROOT; // optional: dir containing pi-coding-agent/
let pi, ai;
try {
	if (PKG_ROOT) {
		pi = await import(pathToFileURL(`${PKG_ROOT}/pi-coding-agent/dist/index.js`).href);
		ai = await import(pathToFileURL(`${PKG_ROOT}/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js`).href);
	} else {
		pi = await import("@earendil-works/pi-coding-agent");
		ai = await import("@earendil-works/pi-ai");
	}
} catch (importErr) {
	console.error("Cannot resolve pi packages. Run `npm install`, or set PI_PKG_ROOT to the");
	console.error("node_modules-level directory that contains pi-coding-agent/.\n", importErr);
	process.exit(2);
}
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = pi;
const { createAssistantMessageEventStream } = ai;

const AGENT_DIR = join(SPIKE, ".agent");
mkdirSync(AGENT_DIR, { recursive: true });

// ---------------------------------------------------------------- scripted provider
let uidN = 0;
const uid = (p) => `${p}_${++uidN}`;
const requests = []; // {n, msgCount, lastUserText, signature}
let SCRIPT = []; // array of (messages) => {content, stopReason}

function buildAssistant(spec) {
	const usage = {
		input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: spec.content,
		api: "spike-api",
		provider: "spike",
		model: "script",
		usage,
		stopReason: spec.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

function scriptedStream(_model, context) {
	const stream = createAssistantMessageEventStream();
	const n = requests.length + 1;
	const msgs = context.messages ?? [];
	requests.push({ n, msgCount: msgs.length, signature: signature(msgs) });
	const step = SCRIPT.shift();
	if (!step) {
		const am = buildAssistant({ content: [{ type: "text", text: "SCRIPT_EXHAUSTED" }], stopReason: "stop" });
		queueMicrotask(() => { stream.push({ type: "start", partial: am }); stream.push({ type: "done", reason: "stop", message: am }); stream.end(am); });
		return stream;
	}
	const spec = typeof step === "function" ? step(msgs) : step;
	const am = buildAssistant(spec);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: am });
		stream.push({ type: "done", reason: am.stopReason === "toolUse" ? "toolUse" : "stop", message: am });
		stream.end(am);
	});
	return stream;
}

function signature(msgs) {
	return msgs.map((m) => {
		const role = m.role;
		let text = "";
		if (m.role === "compactionSummary") text = m.summary ?? ""; // content-less carrier shape
		else if (typeof m.content === "string") text = m.content;
		else if (Array.isArray(m.content)) text = m.content.map((b) => b?.text ?? b?.thinking ?? (b?.type === "toolCall" ? `CALL:${b.name}` : "")).join(" ");
		else if (m.role === "toolResult") text = JSON.stringify(m.content);
		return `${role}~${String(text).replace(/\s+/g, " ").slice(0, 60)}`;
	}).join("||");
}

// convenience builders for scripts
const text = (t) => ({ content: [{ type: "text", text: t }], stopReason: "stop" });
const calls = (list, t) => ({
	content: [
		...(t ? [{ type: "text", text: t }] : []),
		...list.map(([name, args]) => ({ type: "toolCall", id: uid(name), name, arguments: args })),
	],
	stopReason: "toolUse",
});

// ---------------------------------------------------------------- session
const modelRuntime = await ModelRuntime.create({
	authPath: join(AGENT_DIR, "auth.json"),
	modelsPath: join(AGENT_DIR, "models.json"),
});
modelRuntime.registerProvider("spike", {
	apiKey: "spike-local",
	baseUrl: "http://127.0.0.1:9/spike",
	api: "spike-api",
	streamSimple: scriptedStream,
	models: [{
		id: "script", name: "Script", type: "chat", reasoning: false, api: "spike-api",
		contextWindow: 32000, maxTokens: 2000, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}],
});
const model = modelRuntime.getModel("spike", "script");
if (!model) throw new Error("spike model not registered");

const resourceLoader = new DefaultResourceLoader({
	cwd: SPIKE,
	agentDir: AGENT_DIR,
	additionalExtensionPaths: [join(SPIKE, "extension", "forkjoin.ts"), join(SPIKE, "test", "ext", "side.ts")],
});
await resourceLoader.reload();

const sm = SessionManager.inMemory(SPIKE);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });

const { session } = await createAgentSession({
	cwd: SPIKE,
	agentDir: AGENT_DIR,
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	sessionManager: sm,
	settingsManager,
	noTools: true,
});

// SPIKE NOTE: commandContextActions (navigateTree etc.) are bound by pi MODES
// (interactive/rpc/print), not by the SDK factory. Without this the runner's
// no-op stub silently swallows navigateTree. Mirrors print-mode's bindings.
await session.bindExtensions({
	mode: "print",
	commandContextActions: {
		waitForIdle: () => session.waitForIdle(),
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async (targetId, options) => ({
			cancelled: (await session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			})).cancelled,
		}),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	},
	onError: (err) => console.error("[ext-error]", err),
});

// ---------------------------------------------------------------- helpers
const results = [];
function check(name, cond, note = "") {
	results.push({ name, pass: !!cond, note });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}
function branchEntries() { return sm.getBranch(); }
function branchText() {
	return branchEntries().map((e) => {
		if (e.type === "custom_message") return `CM(${e.customType}):${JSON.stringify(e.content).slice(0, 80)}`;
		if (e.type === "custom") return `C(${e.customType})`;
		const m = e.message; if (!m) return e.type;
		if (m.role === "assistant") return `A:${(m.content ?? []).map((b) => b.type === "toolCall" ? `CALL:${b.name}` : (b.text ?? b.thinking ?? "").slice(0, 40)).join("+")}`;
		if (m.role === "toolResult") return `R(${m.toolName})${m.isError ? "!" : ""}:${JSON.stringify(m.content).slice(0, 60)}`;
		if (m.role === "user") return `U:${JSON.stringify(m.content).slice(0, 60)}`;
		return m.role;
	}).join("\n   ");
}
async function turn(prompt, script) {
	SCRIPT.push(...script);
	await session.prompt(prompt);
	await session.waitForIdle();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label = "") {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (pred()) return true;
		await sleep(25);
	}
	return false;
}
const joinNotes = () => sm.getEntries().filter((e) => e.type === "custom_message" && e.customType === "forkjoin/join");
async function settleCommit(parentMarker, prevNoteCount) {
	const gotNote = await waitFor(() => joinNotes().length > prevNoteCount, 20000, "join note");
	if (gotNote) await waitFor(() => branchText().includes(parentMarker), 15000, parentMarker);
	await session.waitForIdle();
	await sleep(100);
	return gotNote;
}

// ---------------------------------------------------------------- scenarios
console.log("\n=== S0: join with no fork (root walk) ===");
await turn("S0: call join right away.", [
	() => calls([["join", { message: "orphan join" }]]),
	(msgs) => {
		const last = msgs[msgs.length - 1];
		const blocked = JSON.stringify(last?.content ?? "").includes("no active fork");
		check("S0 orphan join rejected", blocked, JSON.stringify(last?.content ?? "").slice(0, 80));
		return text("noted");
	},
]);

console.log("\n=== S1: exclusivity on fork ===");
await turn("S1: in ONE assistant turn call probe and fork together.", [
	() => calls([["probe", { note: "sibling-of-fork" }], ["fork", { label: "bad-fork" }]], "batching"),
	(msgs) => {
		const last = msgs[msgs.length - 1];
		const s = JSON.stringify(last?.content ?? "");
		check("S1 batched fork rejected", s.includes("only tool call"), s.slice(0, 100));
		return text("noted");
	},
]);
{
	const bt = branchText();
	check("S1 sibling probe still ran", bt.includes("sibling-of-fork"));
	check("S1 no fork opened", !bt.includes("FORK OPEN"));
}

console.log("\n=== S2: happy-path fork → child work → join → commit bridge ===");
await turn("S2: fork now (alone).", [
	() => calls([["fork", { label: "triage-x" }]]),
	() => text("child ack"), // consumes the post-fork continuation request
]);
{
	const bt = branchText();
	check("S2 fork opened", bt.includes("FORK OPEN"));
}
// child segment: nested fork rejected; probe+join batch rejected; probe; solo join;
// then the SAME prompt continues as the parent (boundary commit mid-run).
await turn("S2b: continue in child.", [
	() => calls([["fork", { label: "nested-bad" }]]),
	(msgs) => {
		const s = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
		check("S2 nested fork rejected with no-ever-called evidence", s.includes("NO JOIN WAS EVER CALLED"), s.slice(0, 110));
		check("S2 diagnostic: no-UI exit hint omits ask-the-user", !s.includes("/abandon-fork") && s.includes("Call join(message) alone"), "");
		return calls([["probe", { note: "CHILD-MARKER-1" }], ["join", { message: "too soon" }]]);
	},
	(msgs) => {
		const s = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
		check("S2 batched join rejected", s.includes("only tool call"), s.slice(0, 90));
		return calls([["join", { message: "REPORT: child did X. verdict: ok." }]]);
	},
	// parent continuation turn — same prompt(), after the boundary commit:
	(msgs) => {
		const sig = signature(msgs);
		check("S2 parent context has join note", sig.includes("[join triage-x]"), sig.slice(-140));
		check("S2 parent context excludes CHILD-MARKER-1", !sig.includes("CHILD-MARKER-1"), `msgs=${msgs.length}`);
		check("S2 parent context manifest present", JSON.stringify(msgs).includes("child tool calls"), "");
		return text("PARENT-AFTER-JOIN");
	},
]);
{
	check("S2 note durable at prompt return (in-run commit)", joinNotes().length === 1);
	const gotNote = await settleCommit("PARENT-AFTER-JOIN", 0);
	check("S2 commit delivered join note", gotNote);
	const bt = branchText();
	check("S2 parent branch continues after fork root", bt.includes("PARENT-AFTER-JOIN"));
	check("S2 child marker off active branch", !bt.includes("CHILD-MARKER-1"));
	const all = sm.getEntries();
	check("S2 child subtree preserved", all.some((e) => JSON.stringify(e).includes("CHILD-MARKER-1")));
	const forkRootE = all.find(
		(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "fork"
			&& JSON.stringify(e.message?.content ?? "").includes("FORK OPEN: triage-x"),
	);
	const note0 = joinNotes()[0];
	check("S2 boundary note parent is the fork root", !!note0 && !!forkRootE && note0.parentId === forkRootE.id,
		`note.parent=${note0?.parentId} forkRoot=${forkRootE?.id}`);
	const reqParent = requests.find((r) => r.signature.includes("[join triage-x]"));
	const childMax = Math.max(0, ...requests.filter((r) => reqParent && r.n < reqParent.n && r.signature.includes("CHILD-MARKER-1")).map((r) => r.msgCount));
	check("S2 parent continuation rebuilt smaller from tree", !!reqParent && reqParent.msgCount < childMax,
		`parent=${reqParent?.msgCount} childMax=${childMax}`);
	const joinNote = branchEntries().find((e) => e.type === "custom_message" && e.customType === "forkjoin/join");
	check("S2 join note embeds manifest line", JSON.stringify(joinNote?.content ?? "").includes("probe"), JSON.stringify(joinNote?.content ?? "").slice(0, 140));
}

console.log("\n=== S3: join twice rejected, then abandon → child continues → re-fork ===");
await turn("S3: fork again and work.", [
	() => calls([["fork", { label: "sidequest" }]]),
	() => calls([["probe", { note: "CHILD-C-KEEP" }]]),
	(msgs) => text("child waiting for human"),
]);
{
	await turn("/abandon-fork", []);
	check("S3 abandon marker present", branchText().includes("C(forkjoin/abandon)"));
	check("S3 child transcript retained", branchText().includes("CHILD-C-KEEP"));
}
await turn("S3b: after abandon, fork again (walk must see abandon as terminal).", [
	() => calls([["fork", { label: "post-abandon-fork" }]]),
	(msgs) => {
		const s = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
		check("S3 fork valid after abandon", s.includes("FORK OPEN"), s.slice(0, 80));
		return calls([["join", { message: "short child" }]]);
	},
	(msgs) => {
		const sig = signature(msgs);
		check("S3 parent has both abandoned work and join", sig.includes("CHILD-C-KEEP") && sig.includes("[join post-abandon-fork]") && sig.includes("short child"), `msgs=${msgs.length}`);
		check("S3 abandoned transcript is mainline", !sig.includes("SCRIPT_EXHAUSTED"), "");
		return text("PARENT-AFTER-J2");
	},
]);
check("S3 commit delivered second join note", await settleCommit("PARENT-AFTER-J2", 1));

console.log("\n=== S4: stale staged entry off-branch does not re-commit ===");
// After two commits, branch already contains join notes; a stray commit must be a no-op.
await turn("/forkjoin-commit", []);
check("S4 no third join note", branchEntries().filter((e) => e.type === "custom_message" && e.customType === "forkjoin/join").length === 2);

console.log("\n=== S4b: plain turns never re-commit (turn_end guard) ===");
{
	const before = joinNotes().length;
	await turn("S4b: just answer.", [() => text("ok, nothing to join")]);
	check("S4b plain turn did not re-commit", joinNotes().length === before, `notes=${joinNotes().length} before=${before}`);
}

console.log("\n=== S5: navigate human-back into child, re-join creates new continuation ===");
// simulate human tree nav: find first fork-open toolResult entry (S2 fork root child side)
const entries = sm.getEntries();
const childJoinResult = entries.find(
	(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "join"
		&& JSON.stringify(e.message?.content ?? "").includes("join staged"),
);
if (childJoinResult) {
	// branch to the child leaf (path contains fork-open + staged entry)
	sm.branch(childJoinResult.id);
	await turn("/forkjoin-commit", [
		(msgs) => {
			const sig = signature(msgs);
			check("S5 re-join from child creates fresh continuation", sig.includes("[join triage-x]"), `msgs=${msgs.length}`);
			check("S5 fresh continuation lacks CHILD-MARKER-1", !sig.includes("CHILD-MARKER-1"), "");
			return text("REJOIN-CONT");
		},
	]);
	await settleCommit("REJOIN-CONT", 2);
	const bt = branchText();
	check("S5 continuation sits on parent path (no child marker in branch)", bt.includes("REJOIN-CONT") && !bt.includes("CHILD-MARKER-1"));
} else {
	check("S5 child join-result entry findable", false, "no staged join result");
}

console.log("\n=== S6: crashed-run staged join recovered by /forkjoin-commit ===");
await turn("S6: fork, work, then stop without joining.", [
	() => calls([["fork", { label: "crashchild" }]]),
	() => calls([["probe", { note: "CRASH-MARKER-9" }]]),
	() => text("child falls silent (simulated crash)"),
]);
{
	const branchNow = sm.getBranch();
	const forkRootE = [...branchNow].reverse().find(
		(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "fork"
			&& JSON.stringify(e.message?.content ?? "").includes("FORK OPEN: crashchild"),
	);
	check("S6 fork root found", !!forkRootE);
	// Simulate a run that staged a join then died before the boundary commit:
	sm.appendCustomEntry("forkjoin/staged", {
		forkRootEntryId: forkRootE.id,
		forkLabel: "crashchild",
		message: "RECOVERED REPORT: child died mid-thought",
		manifest: "call probe: CRASH-MARKER-9",
		stampedAt: new Date().toISOString(),
	});
	const before = joinNotes().length;
	await turn("/forkjoin-commit", [
		(msgs) => {
			const sig = signature(msgs);
			check("S6 recovery note visible to parent", sig.includes("RECOVERED REPORT"), `msgs=${msgs.length}`);
			return text("PARENT-RECOVERED");
		},
	]);
	check("S6 recovery committed note", joinNotes().length === before + 1);
	check("S6 parent branch lacks the child probe result",
		!sm.getBranch().some((e) => e.type === "message" && e.message?.role === "toolResult" && JSON.stringify(e.message?.content ?? "").includes("CRASH-MARKER-9")));
	check("S6 child transcript preserved off-branch",
		sm.getEntries().some((e) => e.type === "message" && JSON.stringify(e.message?.content ?? "").includes("CRASH-MARKER-9")));
}

console.log("\n=== S7: compaction inside child (marker cut from model context), then join ===");
await turn("S7: fork, work, pause at idle with fork open.", [
	() => calls([["fork", { label: "deep-dive" }]]),
	() => calls([["probe", { note: "S7-DEEP-1" }]]),
	() => text("child pauses at idle, fork still open"),
]);
{
	// Child survives across prompt() boundaries (walk-based liveness).
	check("S7 child live across prompts (marker on branch)", branchText().includes("FORK OPEN: deep-dive"));
	// Simulated auto-compaction INSIDE the child, cutting the fork marker out of
	// the model-visible projection (firstKept = child's first probe result).
	const kept = sm.getEntries().reverse().find(
		(e) => e.type === "message" && e.message?.role === "toolResult" && JSON.stringify(e.message?.content ?? "").includes("S7-DEEP-1"),
	);
	check("S7 kept-entry found", !!kept);
	sm.appendCompaction("COMPACTED CHILD CONTEXT: child investigated S7-DEEP-1 thoroughly.", kept.id, 20000, undefined, true);
}
await turn("S7b: continue child after compaction; probe; join.", [
	(msgs) => {
		const sig = signature(msgs);
		check("S7 model context lost fork marker (projection cut)", !sig.includes("FORK OPEN: deep-dive"), `msgs=${msgs.length}`);
		check("S7 compaction summary visible in model context", JSON.stringify(msgs).includes("COMPACTED CHILD CONTEXT"), ""); // convertToLlm: role user + template prefix
		return calls([["probe", { note: "S7-DEEP-3" }]]);
	},
	() => calls([["join", { message: "REPORT-POST-COMPACT: verdict stands." }]]),
	(msgs) => {
		const sig = signature(msgs);
		check("S7 join works despite mid-child compaction", sig.includes("REPORT-POST-COMPACT"), `msgs=${msgs.length}`);
		check("S7 parent context is full parent path (marker visible again)", sig.includes("FORK OPEN: deep-dive"), "");
		return text("PARENT-AFTER-S7");
	},
]);
{
	check("S7 parent branch carries no child probe results",
		!sm.getBranch().some((e) => e.type === "message" && e.message?.role === "toolResult" && JSON.stringify(e.message?.content ?? "").includes("S7-DEEP")));
	check("S7 compaction entry stays in child subtree", !sm.getBranch().some((e) => e.type === "compaction") && sm.getEntries().some((e) => e.type === "compaction"));
}

console.log("\n=== S8: partial commit (branch moved, note lost) -> model re-joins at root ===");
await turn("S8: fork and work.", [
	() => calls([["fork", { label: "fragile" }]]),
	() => calls([["probe", { note: "S8-WORK" }]]),
	() => text("child idles"),
]);
{
	const rootE = [...sm.getBranch()].reverse().find(
		(e) => e.type === "message" && e.message?.toolName === "fork" && JSON.stringify(e.message?.content ?? "").includes("FORK OPEN: fragile"),
	);
	check("S8 fork root found", !!rootE);
	// Simulate a crash AFTER branch() but BEFORE the boundary note commit:
	// leaf sits exactly at the fork root; walk sees the fork live; nothing lost.
	sm.branch(rootE.id);
}
await turn("S8b: re-join from fork root after lost commit.", [
	() => calls([["join", { message: "REREGISTERED REPORT" }]]),
	(msgs) => {
		const sig = signature(msgs);
		check("S8 re-join committed after partial failure", sig.includes("REREGISTERED REPORT"), `msgs=${msgs.length}`);
		return text("PARENT-AFTER-S8");
	},
]);
check("S8 exactly one rejoin note", joinNotes().filter((e) => JSON.stringify(e.content).includes("REREGISTERED REPORT")).length === 1);

console.log("\n=== S10: nested-fork diagnostic is state-dependent (staged-but-uncommitted) ===");
await turn("S10: fork, work, simulate aborted join, try fork again.", [
	() => calls([["fork", { label: "diag" }]]),
	() => calls([["probe", { note: "DIAG-LAST-ACTION" }]]),
	(msgs) => {
		// Simulate a join turn that died after staging but before boundary commit.
		const root = [...sm.getBranch()].reverse().find(
			(e) => e.type === "message" && e.message?.toolName === "fork" && JSON.stringify(e.message?.content ?? "").includes("FORK OPEN: diag"),
		);
		sm.appendCustomEntry("forkjoin/staged", { forkRootEntryId: root.id, forkLabel: "diag", message: "aborted", manifest: "", stampedAt: new Date().toISOString() });
		return calls([["fork", { label: "nested-again" }]]);
	},
	(msgs) => {
		const s = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
		check("S10 staged-but-uncommitted state named", s.includes("WAS STAGED") && s.includes("never committed"), s.slice(0, 140));
		check("S10 quotes last child action as evidence", s.includes("DIAG-LAST-ACTION"), "");
		return calls([["join", { message: "diag complete" }]]);
	},
	(msgs) => {
		check("S10 re-join recovers cleanly after staged-unclean state", signature(msgs).includes("diag complete"), "");
		return text("PARENT-AFTER-S10");
	},
]);

console.log("\n=== S9: v1 features — manifest ids, child_call spill, fork label, side-entry preservation ===");
let s9TargetId = "";
await turn("S9: fork, big probe, join, then child_call the probe result.", [
	() => calls([["fork", { label: "labeled-9" }]]),
	() => calls([["probe", { note: "S9-BIG|" + "PAYLOAD-9 ".repeat(700) }]]),
	() => calls([["join", { message: "S9 REPORT: saw the payload." }]]),
	(msgs) => {
		const noteIdx = msgs.findLastIndex((m) => JSON.stringify(m).includes("S9 REPORT"));
		const noteTxt = JSON.stringify(msgs[noteIdx] ?? {});
		const mres = noteTxt.match(/-> probe \[([0-9a-f]+)\]/);
		check("S9 manifest lines carry entry ids", !!mres, mres ? mres[1] : noteTxt.slice(0, 140));
		s9TargetId = mres ? mres[1] : "";
		return calls([["child_call", { id: s9TargetId || "deadbeef" }]]);
	},
	(msgs) => {
		const s = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
		check("S9 child_call spills oversized readback", s.includes("FULL:") && s.includes(".forkjoin"), s.slice(-120));
		check("S9 readback carries args + lineage stamp", s.includes("[args probe]") && s.includes("fork:labeled-9"), s.slice(0, 120));
		return text("PARENT-AFTER-S9");
	},
]);
{
	const fs = await import("node:fs");
	const forkAsst = sm.getEntries().find(
		(e) => e.type === "message" && e.message?.role === "assistant"
			&& (e.message.content ?? []).some((b) => b?.type === "toolCall" && b.name === "fork" && b.arguments?.label === "labeled-9"),
	);
	check("S9 fork entry labeled for /tree", !!forkAsst && sm.getLabel?.(forkAsst.id) === "fork: labeled-9", forkAsst ? String(sm.getLabel?.(forkAsst.id)) : "no entry");
	if (s9TargetId) {
		const p = join(SPIKE, ".forkjoin", `readback-${s9TargetId}.txt`);
		check("S9 spill file holds the full payload", fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("PAYLOAD-9 ".repeat(700)), p);
	} else check("S9 spill target id captured", false, "manifest id regex failed");
	const sideNotes = sm.getEntries().filter((e) => e.type === "custom_message" && e.customType === "side/note");
	check("S9 side-extension drafts preserved across joins", sideNotes.length >= 2, `side=${sideNotes.length}`);
	const s2note = joinNotes()[0];
	check("S9 side entry chained after join note on parent branch", sideNotes.some((s) => s.parentId === s2note.id), `s2note=${s2note?.id}`);
	check("S9 join notes survived alongside side drafts (no list clobber)", joinNotes().length === 8, `joins=${joinNotes().length}`); // S2,S3,S5,S6,S7,S8,S10,S9
}

console.log("\n=== S11: zero-call child: manifest must not list its own join ===");
await turn("S11: fork then immediately join.", [
	() => calls([["fork", { label: "instant" }]]),
	() => calls([["join", { message: "thought-only child" }]]),
	(msgs) => text("PARENT-AFTER-S11"),
]);
{
	const allNotes = JSON.stringify(joinNotes().map((n) => n.content));
	check("S11 no manifest lists a child's own join call", !allNotes.includes("call join"), allNotes.slice(0, 120));
	const s11note = joinNotes().find((n) => JSON.stringify(n.content).includes("thought-only child"));
	const txt = JSON.stringify(s11note?.content ?? "");
	check("S11 zero-call manifest is empty of tool lines", !txt.includes("-> ") && !txt.includes("call "), txt.slice(0, 160));
}

// ---------------------------------------------------------------- report
console.log("\n=== request log (provider calls) ===");
for (const r of requests) console.log(`  req#${r.n} msgs=${r.msgCount}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} passed ===`);
session.dispose();
process.exit(failed.length ? 1 : 0);
