/**
 * Side test extension: proves boundary-entry preservation (the keep-valid
 * pattern). Registered AFTER forkjoin; on any turn_end whose accumulated
 * entries list is non-empty (i.e., forkjoin just contributed a join note),
 * it appends its own draft. If forkjoin dropped event.entries, this entry
 * would still appear but forkjoin's join note would be GONE (pi replaces the
 * list per handler) — which the harness would catch as missing join notes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("turn_end" as any, async (event: any) => {
		const entries = ((event?.entries ?? []) as any[]).filter(Boolean);
		if (!entries.length) return undefined;
		if (entries.some((d: any) => d?.details?.side)) return undefined; // once per list
		return {
			entries: [
				...entries,
				{
					type: "custom_message",
					customType: "side/note",
					content: [{ type: "text", text: "SIDE-ENTRY-PRESERVED" }],
					display: true,
					details: { side: true },
				},
			],
		};
	});
}
